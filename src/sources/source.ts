import type { ReviewContext } from '../lib/types.js';

export interface ReviewSource {
  buildContext(issueFlag?: number): Promise<ReviewContext>;
}
