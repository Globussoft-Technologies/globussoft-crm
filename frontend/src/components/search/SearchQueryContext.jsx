import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const noop = () => {};

const defaultSearchQueryContext = {
  query: '',
  setQuery: noop,
  clearQuery: noop,
};

const SearchQueryContext = createContext(defaultSearchQueryContext);

export function SearchQueryProvider({
  children,
  initialQuery = '',
  resetKey,
}) {
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery, resetKey]);

  const clearQuery = useCallback(() => {
    setQuery('');
  }, []);

  const value = useMemo(
    () => ({
      query,
      setQuery,
      clearQuery,
    }),
    [query, clearQuery],
  );

  return (
    <SearchQueryContext.Provider value={value}>
      {children}
    </SearchQueryContext.Provider>
  );
}

export function useSearchQuery() {
  return useContext(SearchQueryContext) || defaultSearchQueryContext;
}

export default SearchQueryContext;
