/**
 * Joins a parent path and a file name into the rooted logical path an operator types.
 *
 * A root-level item carries `parent_path` of `/`, both when Graph omits the parent reference and
 * when the path ends at `root:`, so concatenating produces `//Report.docx` and nothing an operator
 * can type will match it (issue #299). One helper because the manifest filter and the version
 * index build the same string from different record shapes.
 */
export function join_drive_path(parent_path: string, file_name: string): string {
  const base = parent_path.replace(/\/+$/, '');
  if (base === '') return `/${file_name}`;
  return `${base}/${file_name}`;
}
