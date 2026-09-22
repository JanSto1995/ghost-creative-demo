import { z } from 'zod';

export const briefSchema = z
  .object({ subject: z.string().trim().min(3).max(400), format: z.enum(['square', 'portrait']) })
  .strict();
export const creativeSchema = z
  .object({
    hook: z.string().trim().min(1).max(90),
    caption: z.string().trim().min(1).max(240),
    format: z.enum(['square', 'portrait']),
    palette: z.enum(['violet', 'citrus', 'ink']),
  })
  .strict();
export type Creative = z.infer<typeof creativeSchema>;
export const statusSchema = z.enum(['pending', 'approved', 'rejected']);
export const queueItemSchema = creativeSchema.extend({
  id: z.string().uuid().toLowerCase(),
  status: statusSchema,
});
export type QueueItem = z.infer<typeof queueItemSchema>;
export const decisionSchema = z
  .object({ id: z.string().uuid().toLowerCase(), action: z.enum(['approve', 'reject']) })
  .strict();
export type Decision = z.infer<typeof decisionSchema>;
export const keySchema = z.string().uuid().toLowerCase();
export const snapshotSchema = z
  .object({
    items: z.array(queueItemSchema),
    balance: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const decisionReplySchema = z
  .object({ snapshot: snapshotSchema, replayed: z.boolean() })
  .strict();

// These are synthetic display fixtures, not generated production assets.
export const fixtures: QueueItem[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    hook: 'Make room for a slower morning.',
    caption: 'A little light. A fresh page. A different kind of start.',
    format: 'portrait',
    palette: 'violet',
    status: 'pending',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    hook: 'Small rituals. Bright ideas.',
    caption: 'Find a little space for something new.',
    format: 'square',
    palette: 'citrus',
    status: 'pending',
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    hook: 'Less noise. More possibility.',
    caption: 'A blank canvas for your next good idea.',
    format: 'portrait',
    palette: 'ink',
    status: 'pending',
  },
];
