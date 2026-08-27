import { createContext } from 'react';

/**
 * The app's two React contexts, kept OUT of App.jsx on purpose.
 *
 * App.jsx exports components. A module that exports both components and
 * non-components defeats React Fast Refresh — on every hot update the module
 * is re-evaluated, `createContext()` runs again, and children still mounted
 * under the previous provider read a brand-new context object. With no default
 * value that read is `undefined`, and since every consumer destructures
 * (`const { user } = useContext(AuthContext)`), the whole app died with
 * "Cannot destructure property 'user' of 'useContext(...)' as it is undefined"
 * behind an error boundary. Living here, the context objects survive an edit to
 * App.jsx and stay identical for provider and consumer.
 *
 * The defaults below are the second line of defence: a consumer that genuinely
 * renders outside the provider gets a logged-out shape and a page that renders,
 * rather than a blank screen.
 *
 * App.jsx re-exports both names, so the ~230 existing
 * `import { AuthContext } from '../App'` sites keep working unchanged.
 */

const LOGGED_OUT_AUTH = Object.freeze({
  user: null,
  setUser: () => {},
  token: null,
  setToken: () => {},
  tenant: null,
  setTenant: () => {},
  loading: false,
  loginWithToken: () => {},
  subscription: null,
});

const DEFAULT_THEME = Object.freeze({
  theme: 'system',
  setTheme: () => {},
  toggleTheme: () => {},
});

export const AuthContext = createContext(LOGGED_OUT_AUTH);
export const ThemeContext = createContext(DEFAULT_THEME);
