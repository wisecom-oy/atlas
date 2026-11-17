import { existsSync } from 'node:fs';
import { logger } from '@wisecom/atlas-core';
import { ask_confirmation } from '@/ui/components/confirm-prompt';

/**
 * Asks before a save replaces an existing `--output` file. Returns `true` when the save may run.
 *
 * Nothing is asked when no output path is given, when the path does not exist yet, or when `-y`
 * skips the question. A declined question logs `Cancelled.` and returns `false`. Stdin that ends
 * before an answer throws `PromptUnansweredError` instead of settling on a default. Callers invoke
 * this before any Graph call or storage read, so a refusal leaves the existing file untouched.
 */
export async function confirm_output_overwrite(
  output_path: string | undefined,
  skip_prompt = false,
): Promise<boolean> {
  if (!output_path || skip_prompt || !existsSync(output_path)) return true;
  const proceed = await ask_confirmation(`File "${output_path}" already exists. Overwrite?`, true);
  if (!proceed) logger.info('Cancelled.');
  return proceed;
}
