/**
 * GDPR retention: purge aged transcripts/notes and anonymize caller numbers.
 * See ./job.js for the scheduler and purge contract (design D9).
 */
export {
  anonymizeNumber,
  RETENTION_BATCH_SIZE,
  RETENTION_TICK_MS,
  RetentionJob,
  type RetentionJobOptions,
  type RetentionRunSummary,
} from "./job.js";
