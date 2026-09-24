import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from './machine';
import { mandateMachine } from './mandate';
import { briefMachine } from './brief';
import { contentPackageMachine } from './content-package';
import { experimentMachine } from './experiment';

describe('mandate state machine (spec 6.3 publishing_mandates)', () => {
  it('active ↔ paused; revoked and expired are final', () => {
    expect(mandateMachine.transition('active', 'pause')).toBe('paused');
    expect(mandateMachine.transition('paused', 'resume')).toBe('active');
    expect(mandateMachine.transition('active', 'revoke')).toBe('revoked');
    expect(mandateMachine.transition('paused', 'expire')).toBe('expired');
    for (const s of ['revoked', 'expired'] as const)
      for (const e of mandateMachine.events) expect(mandateMachine.can(s, e)).toBe(false);
    expect(() => mandateMachine.transition('active', 'resume')).toThrow(IllegalTransitionError);
  });
});

describe('brief state machine (spec 6.3 briefs)', () => {
  it('draft → accepted → in_progress → delivered; cancel until delivered; terminal states are final', () => {
    expect(briefMachine.transition('draft', 'accept')).toBe('accepted');
    expect(briefMachine.transition('accepted', 'start')).toBe('in_progress');
    expect(briefMachine.transition('in_progress', 'deliver')).toBe('delivered');
    expect(briefMachine.transition('accepted', 'cancel')).toBe('cancelled');
    expect(briefMachine.can('draft', 'start')).toBe(false);
    for (const s of briefMachine.terminal)
      for (const e of briefMachine.events) expect(briefMachine.can(s, e)).toBe(false);
  });
});

describe('content package state machine (spec 6.3 content_packages)', () => {
  it('follows its current revision and returns to draft on revise; archived is final', () => {
    expect(contentPackageMachine.transition('draft', 'request_review')).toBe('in_review');
    expect(contentPackageMachine.transition('in_review', 'approve')).toBe('approved');
    expect(contentPackageMachine.transition('in_review', 'request_changes')).toBe('draft');
    expect(contentPackageMachine.transition('approved', 'revise')).toBe('draft');
    expect(contentPackageMachine.transition('approved', 'schedule')).toBe('scheduled');
    expect(contentPackageMachine.transition('scheduled', 'publish')).toBe('published');
    expect(contentPackageMachine.can('draft', 'approve')).toBe(false);
    expect(contentPackageMachine.transition('draft', 'revise')).toBe('draft');
    for (const e of contentPackageMachine.events)
      expect(contentPackageMachine.can('archived', e)).toBe(false);
  });
});

describe('experiment state machine (spec 16.6)', () => {
  it('designed → pre_registered → running → stopped → analysed; a sequential rule may analyse while running', () => {
    expect(experimentMachine.transition('designed', 'pre_register')).toBe('pre_registered');
    expect(experimentMachine.transition('pre_registered', 'start')).toBe('running');
    expect(experimentMachine.transition('running', 'stop')).toBe('stopped');
    expect(experimentMachine.transition('running', 'analyse')).toBe('analysed');
    expect(experimentMachine.transition('stopped', 'analyse')).toBe('analysed');
    expect(experimentMachine.can('designed', 'start')).toBe(false);
    expect(() => experimentMachine.transition('pre_registered', 'pre_register')).toThrow(
      IllegalTransitionError,
    );
    for (const e of experimentMachine.events) expect(experimentMachine.can('analysed', e)).toBe(false);
  });
});
