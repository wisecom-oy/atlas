import type { DriveFolderColor } from '@wisecom/atlas-types';

/** The colour, or undefined when none of its columns holds a value. */
export function present_folder_color(
  color: DriveFolderColor | undefined,
): DriveFolderColor | undefined {
  if (color === undefined) return undefined;
  const has_value = [color.color_hex, color.color_tag, color.emoji].some(
    (value) => value !== undefined && value.length > 0,
  );
  return has_value ? color : undefined;
}

/** Whether two colours hold the same values; two absent colours are equal. */
export function same_folder_color(
  a: DriveFolderColor | undefined,
  b: DriveFolderColor | undefined,
): boolean {
  return a?.color_hex === b?.color_hex && a?.color_tag === b?.color_tag && a?.emoji === b?.emoji;
}
