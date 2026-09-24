// Content (spec 6.3 content tables, 7.5 content router): campaigns, briefs, packages with immutable content
// revisions, channel variants and the calendar. The review and publishing modules read revisions and variants here.
export {
  contentService,
  hashesForVariant,
  contentClassOf,
  registerChannelResolver,
  resetChannelResolver,
  registerCalendarSource,
  registerRevisionChangeListener,
  registerLinkTracker,
  registerAttributeCapturer,
  type ChannelDescription,
  type ChannelResolver,
  type CalendarSource,
  type RevisionChange,
  type RevisionChangeListener,
  type LinkTracker,
  type LinkTrackingInput,
  type AttributeCapturer,
  type AttributeCaptureInput,
  type ContentRevisionDto,
  type ChannelVariantDto,
} from './service';
export {
  CampaignRepository,
  BriefRepository,
  ContentPackageRepository,
  ContentRevisionRepository,
  ChannelVariantRepository,
  CreativeAttributeRepository,
} from './repositories';
