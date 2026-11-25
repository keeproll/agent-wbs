import { createTheme } from '@mantine/core';

export const theme = createTheme({
  fontFamily: 'var(--font)',
  // 고정폭 글꼴을 따로 쓰지 않는다(G§9.7-1).
  fontFamilyMonospace: 'var(--font)',
  headings: { fontFamily: 'var(--font)' },
  respectReducedMotion: true,
});
