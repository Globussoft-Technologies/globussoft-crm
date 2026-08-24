import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalSearchHighlighter from '../components/search/GlobalSearchHighlighter';
import { SearchQueryProvider } from '../components/search/SearchQueryContext';

function Harness() {
  return (
    <>
      <aside data-testid="sidebar" data-search-highlight-scope="global-search">
        Passport queue
      </aside>
      <main data-testid="main" data-search-highlight-scope="global-search">
        Dashboard overview
      </main>
      <GlobalSearchHighlighter />
    </>
  );
}

describe('GlobalSearchHighlighter', () => {
  it('highlights and clears matching text inside every scoped app root', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <SearchQueryProvider initialQuery="as" resetKey="seed">
          <Harness />
        </SearchQueryProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('sidebar').querySelectorAll(
          'mark[data-global-search-highlight="true"]',
        ),
      ).toHaveLength(1);
      expect(
        screen.getByTestId('main').querySelectorAll(
          'mark[data-global-search-highlight="true"]',
        ),
      ).toHaveLength(1);
    });

    rerender(
      <MemoryRouter>
        <SearchQueryProvider initialQuery="" resetKey="cleared">
          <Harness />
        </SearchQueryProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('sidebar').querySelector(
          'mark[data-global-search-highlight="true"]',
        ),
      ).toBeNull();
      expect(
        screen.getByTestId('main').querySelector(
          'mark[data-global-search-highlight="true"]',
        ),
      ).toBeNull();
    });
  });
});
