import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { ConflictError, NotFoundError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ChannelVariantInput, ValidationResult } from '@oremedia/contracts/providers';
import {
  ChannelConnectStart,
  ChannelConnectComplete,
  ChannelDisconnect,
  ChannelList,
} from '@oremedia/contracts/publishing';
import { requireTenant, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { audit, outbox } from '@oremedia/module-operations';
import { missingScopes } from '@oremedia/providers';
import { credentialBroker } from './broker';
import { actorRef, connectionUsable, toConnectionDto, transition, type ConnectionRow } from './common';
import { assertBrandExists, providerClientFor, publishMedia, variants } from './hooks';
import { adapterFor, providerIO } from './providers';
import { ChannelConnectionRepository, CredentialRefRepository, PublicationRepository } from './repositories';

const connectionsRepo = new ChannelConnectionRepository();
const credentialsRepo = new CredentialRefRepository();
const publicationsRepo = new PublicationRepository();

/**
 * PKCE state for an OAuth connect flow, stored server-side with a short TTL and consumed once. The memory store
 * serves a single API process; configureConnectStateStore swaps in a shared (Redis) store for a multi-instance
 * deployment. Nothing here is a durable record (spec 3.1).
 */
export interface ConnectState {
  tenantId: string;
  brandId: string;
  providerKey: string;
  redirectUri: string;
  codeVerifier: string;
  actorId: string;
  expiresAt: number;
}
export interface ConnectStateStore {
  put(state: string, value: ConnectState): Promise<void>;
  /** Removes and returns the value (one-shot); null when unknown or expired. */
  take(state: string): Promise<ConnectState | null>;
}
export class MemoryConnectStateStore implements ConnectStateStore {
  private readonly entries = new Map<string, ConnectState>();
  async put(state: string, value: ConnectState) {
    this.entries.set(state, value);
  }
  async take(state: string) {
    const v = this.entries.get(state);
    this.entries.delete(state);
    return v && v.expiresAt > Date.now() ? v : null;
  }
}
let stateStore: ConnectStateStore = new MemoryConnectStateStore();
export const configureConnectStateStore = (store: ConnectStateStore): void => {
  stateStore = store;
};
/** Short TTL: a person completes the provider's consent screen in minutes, not hours. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const connectionResource = (c: ConnectionRow) => ({
  type: 'channel_connection',
  tenantId: c.tenantId,
  brandId: c.brandId,
  id: c.id,
  channelId: c.id,
});

export const channelService = {
  connect: {
    /** Spec 14.7: the authorization URL with a server-side PKCE verifier; uncertified providers are refused. */
    async start(actor: ResolvedActor, input: z.infer<typeof ChannelConnectStart>, tx: Tx) {
      const parsed = ChannelConnectStart.parse(input);
      await assertBrandExists(parsed.brandId, tx); // a foreign or invisible brand is NOT_FOUND
      await policy.assert(actor, 'channel.connect', brandResource(parsed.brandId), {}, tx);
      const adapter = adapterFor(parsed.providerKey); // CAPABILITY_UNSUPPORTED unless certified (spec 14.6)
      const { tenantId } = requireTenant();
      const state = randomBytes(32).toString('base64url');
      const codeVerifier = randomBytes(48).toString('base64url');
      const expiresAt = Date.now() + CONNECT_STATE_TTL_MS;
      const { url } = await adapter.authorizationUrl({
        state,
        codeVerifier,
        redirectUri: parsed.redirectUri,
        client: providerClientFor(adapter.key),
      });
      await stateStore.put(state, {
        tenantId,
        brandId: parsed.brandId,
        providerKey: adapter.key,
        redirectUri: parsed.redirectUri,
        codeVerifier,
        actorId: actor.id,
        expiresAt,
      });
      await audit.record(
        actorRef(actor),
        'channel.connect.start',
        { type: 'brand', id: parsed.brandId },
        'allowed',
        tx,
        { brandId: parsed.brandId },
      );
      return { state, url, expiresAt: new Date(expiresAt).toISOString() };
    },

    /**
     * Spec 14.7 on connect: the code is exchanged, the grant sealed with a per-record data key (AAD binds it to
     * tenant and connection) and stored as a new credential_refs row; a reconnect of a known remote account rotates
     * the credential and reactivates the connection. Plaintext never reaches the DB, logs or events.
     */
    async complete(actor: ResolvedActor, input: z.infer<typeof ChannelConnectComplete>, tx: Tx) {
      const parsed = ChannelConnectComplete.parse(input);
      const { tenantId } = requireTenant();
      const pending = await stateStore.take(parsed.state);
      if (!pending || pending.tenantId !== tenantId || pending.actorId !== actor.id)
        throw new ValidationFailedError(
          [{ path: 'state', issue: 'connect_state_invalid_or_expired' }],
          'The connect flow has expired; start again',
        );
      await policy.assert(actor, 'channel.connect', brandResource(pending.brandId), {}, tx);
      const adapter = adapterFor(pending.providerKey);
      const grant = await adapter.exchangeCode(
        {
          code: parsed.code,
          codeVerifier: pending.codeVerifier,
          redirectUri: pending.redirectUri,
          client: providerClientFor(adapter.key),
        },
        providerIO(adapter.key, tenantId),
      );
      const existing = await connectionsRepo.findByRemoteAccount(adapter.key, grant.remoteAccountId, tx);
      if (existing && existing.brandId !== pending.brandId)
        throw new ValidationFailedError(
          [{ path: 'providerKey', issue: 'remote_account_connected_to_another_brand' }],
          'This account is already connected to another brand',
        );
      const connectionId = existing?.id ?? newId('channelConnection');
      const sealed = await credentialBroker.seal(tenantId, connectionId, grant.credentials);
      const credentialRefId = newId('credentialRef');
      await credentialsRepo.create({ id: credentialRefId, ...sealed }, tx);
      const scopesMissing = missingScopes(adapter.capability.requiredScopes, grant.grantedScopes);
      const values = {
        displayName: grant.displayName,
        credentialRefId,
        grantedScopes: grant.grantedScopes,
        missingScopes: scopesMissing,
        status: 'active' as const,
        tokenExpiresAt: grant.tokenExpiresAt ? new Date(grant.tokenExpiresAt) : null,
        capabilityVersion: adapter.capability.version,
      };
      let fromState: string | null = null;
      if (existing) {
        const locked = await connectionsRepo.lock(existing.id, tx);
        fromState = locked.status;
        await connectionsRepo.update(locked.id, locked.version, values, tx);
        const old = await credentialsRepo.getById(locked.credentialRefId, tx);
        if (!old.destroyedAt) await credentialsRepo.destroy(old.id, old.version, 'rotated', tx);
      } else {
        await connectionsRepo.create(
          {
            id: connectionId,
            brandId: pending.brandId,
            providerKey: adapter.key,
            remoteAccountId: grant.remoteAccountId,
            ...values,
          },
          tx,
        );
      }
      const row = await connectionsRepo.getById(connectionId, tx);
      await audit.record(
        actorRef(actor),
        existing ? 'channel.reconnect' : 'channel.connect',
        { type: 'channel_connection', id: connectionId },
        'allowed',
        tx,
        { brandId: pending.brandId, channelConnectionId: connectionId, fromState, toState: 'active' },
      );
      await outbox.add(
        'channel.connected',
        { type: 'channel_connection', id: connectionId, version: row.version },
        {
          channelConnectionId: connectionId,
          providerKey: adapter.key,
          actorKind: actor.kind,
          actorId: actor.id,
          reconnect: existing !== null,
        },
        tx,
        { brandId: pending.brandId },
      );
      return toConnectionDto(row);
    },
  },

  async list(actor: ResolvedActor, input: z.infer<typeof ChannelList>, tx?: Tx) {
    const parsed = ChannelList.parse(input);
    await assertBrandExists(parsed.brandId, tx);
    await policy.assert(actor, 'brand.read', brandResource(parsed.brandId), {}, tx);
    const rows = await connectionsRepo.listForBrand(parsed.brandId, tx);
    return rows.map(toConnectionDto);
  },

  async get(actor: ResolvedActor, channelConnectionId: string, tx?: Tx) {
    const row = await connectionsRepo.getById(channelConnectionId, tx);
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    return toConnectionDto(row);
  },

  /**
   * Spec 14.7 / 17.5 revoke: the credential row is destroyed (data key discarded), the connection disabled and
   * every scheduled publication on it held with reason channel_active, through the publication machine.
   */
  async disconnect(actor: ResolvedActor, input: z.infer<typeof ChannelDisconnect>, tx: Tx) {
    const parsed = ChannelDisconnect.parse(input);
    const row = await connectionsRepo.lock(parsed.channelConnectionId, tx);
    await policy.assert(actor, 'channel.manage', connectionResource(row), {}, tx);
    if (row.version !== parsed.expectedVersion)
      throw new ConflictError('ChannelConnection', row.id, parsed.expectedVersion);
    await connectionsRepo.update(row.id, row.version, { status: 'disabled', tokenExpiresAt: null }, tx);
    const credential = await credentialsRepo.getById(row.credentialRefId, tx);
    if (!credential.destroyedAt)
      await credentialsRepo.destroy(credential.id, credential.version, 'disconnected', tx);
    const held: string[] = [];
    for (const pub of await publicationsRepo.listScheduledForChannel(row.id, tx)) {
      const toState = transition(pub.state, 'dependency_revoked', 'publicationId');
      await publicationsRepo.update(
        pub.id,
        pub.version,
        { state: toState, stateReason: 'channel_disconnected', holdReasons: ['channel_active'] },
        tx,
      );
      await outbox.add(
        'publication.state_changed',
        { type: 'publication', id: pub.id, version: pub.version + 1 },
        { publicationId: pub.id, fromState: pub.state, toState, reason: 'channel_disconnected' },
        tx,
        { brandId: pub.brandId },
      );
      held.push(pub.id);
    }
    await audit.record(
      actorRef(actor),
      'channel.disconnect',
      { type: 'channel_connection', id: row.id },
      'allowed',
      tx,
      {
        brandId: row.brandId,
        channelConnectionId: row.id,
        fromState: row.status,
        toState: 'disabled',
        count: held.length,
      },
    );
    await outbox.add(
      'channel.disconnected',
      { type: 'channel_connection', id: row.id, version: row.version + 1 },
      { channelConnectionId: row.id, providerKey: row.providerKey, heldPublications: held.length },
      tx,
      { brandId: row.brandId },
    );
    const updated = await connectionsRepo.getById(row.id, tx);
    return { ...toConnectionDto(updated), heldPublicationIds: held };
  },

  /** Spec 13.4 `publishing.channelUsable`: false for a foreign or unknown id (never an error). */
  async channelUsable(channelConnectionId: string, tx?: Tx): Promise<boolean> {
    try {
      return connectionUsable(await connectionsRepo.getById(channelConnectionId, tx));
    } catch (err) {
      if (err instanceof NotFoundError) return false;
      throw err;
    }
  },

  /** Spec 13.4 `providers.validateVariant`: pure, capability-driven, against the variant's connection. */
  async validateVariantDetailed(variantId: string, tx?: Tx): Promise<ValidationResult> {
    const variant = await variants.get(variantId, tx);
    const connection = await connectionsRepo.getById(variant.channelConnectionId, tx);
    const adapter = adapterFor(connection.providerKey);
    const media = await publishMedia.describeForVariant(variant, tx); // dimensions only: nothing is minted
    const input: ChannelVariantInput = {
      text: variant.text,
      altTexts: variant.altTexts,
      media: media.map((m) => ({ mime: m.mime, width: m.width, height: m.height, bytes: m.bytes })),
      settings: variant.settings,
    };
    return adapter.validateVariant(input);
  },
  async validateVariant(variantId: string, tx?: Tx): Promise<boolean> {
    return (await channelService.validateVariantDetailed(variantId, tx)).ok;
  },

  /** Content module channel resolver (spec 4.2): a description, never the row; null for a foreign or unknown id. */
  async describe(channelConnectionId: string, tx?: Tx) {
    const row = await connectionsRepo.findById(channelConnectionId, tx);
    return row
      ? { brandId: row.brandId, providerKey: row.providerKey, capabilityVersion: row.capabilityVersion }
      : null;
  },

  /** Usage counter for the `channels` entitlement (composition registers it with the billing module). */
  countActive: (tx?: Tx) => connectionsRepo.countActive(tx),
};
