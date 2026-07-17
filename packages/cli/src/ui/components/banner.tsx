import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { ACCENT_COLOR } from '@/ui/theme';

interface BannerProps {
  title: string;
  subtitle?: string;
}

/** Rounded-border command banner; replaces the legacy dashed logger.banner. */
export function Banner({ title, subtitle }: BannerProps): ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor={ACCENT_COLOR}
      paddingX={2}
      flexDirection="column"
      alignSelf="flex-start"
    >
      <Text bold>{title}</Text>
      {subtitle === undefined ? undefined : <Text dimColor>{subtitle}</Text>}
    </Box>
  );
}
