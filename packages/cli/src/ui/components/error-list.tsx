import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

interface ErrorListProps {
  errors: string[];
  /** Maximum entries shown before collapsing to `… and N more`. */
  max?: number;
}

/** Red bulleted error listing, capped to keep large failure sets readable. */
export function ErrorList({ errors, max = 10 }: ErrorListProps): ReactElement {
  const visible = errors.slice(0, max);
  const hidden = errors.length - visible.length;

  return (
    <Box flexDirection="column">
      {visible.map((error, i) => (
        <Text key={i} color="red">
          {'  - '}
          {error}
        </Text>
      ))}
      {hidden > 0 ? <Text dimColor>{`  … and ${hidden} more`}</Text> : undefined}
    </Box>
  );
}
