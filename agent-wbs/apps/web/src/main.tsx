import '@mantine/core/styles.css';
import './shared/styles/fonts.css';
import './shared/styles/prototype.css';
import './shared/styles/product.css';
import { createTheme, MantineProvider } from '@mantine/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { createRouter } from './app/router.tsx';
import { ApiProvider } from './shared/api/ApiProvider.tsx';
import { FeedbackProvider } from './shared/ui/feedback.tsx';

const theme = createTheme({
  fontFamily: 'var(--font)',
  // 고정폭 글꼴을 따로 쓰지 않는다(G§9.7-1).
  fontFamilyMonospace: 'var(--font)',
  headings: { fontFamily: 'var(--font)' },
  respectReducedMotion: true,
});

const root = document.getElementById('root');
if (!root) throw new Error('#root가 없습니다.');
const router = createRouter();

createRoot(root).render(
  <StrictMode>
    <MantineProvider theme={theme} forceColorScheme="light">
      <ApiProvider>
        <FeedbackProvider>
          <RouterProvider router={router} />
        </FeedbackProvider>
      </ApiProvider>
    </MantineProvider>
  </StrictMode>,
);
