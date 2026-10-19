import { createContext } from 'react';

// Only authenticated Generic tenants opt into the Ant Design icon family.
// Kept independent of App so icons never introduce an AuthContext import cycle.
export const IconThemeContext = createContext(false);
