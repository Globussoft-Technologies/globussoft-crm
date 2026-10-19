# Tenant-aware icon family

Authenticated Generic CRM renders Ant Design outlined SVGs; Travel, Wellness,
public pages and unknown tenants keep the original Lucide icons. Company logos,
illustrations, charts and collaboration-cursor graphics are not replaced.

`App` selects the family through `IconThemeContext`. A documented exact-match
Vite alias routes existing `lucide-react` named imports through `index.jsx`, so
shared pages, portalled dialogs, navigation, controls and notifications switch
together. The original Lucide ESM subpath bypasses that alias and prevents an
import cycle. No bulk source rewrites, full Ant Design CSS, or new control
components are involved.

The adapter uses official `@ant-design/icons-svg` definitions. Many symbols
have direct counterparts; others use the closest semantic Ant Design glyph
(for example, Settings → SettingOutlined, Shield → SafetyOutlined,
IndianRupee → WalletOutlined). Currency labels and values remain actual
currency symbols; the currency action icon is intentionally currency-neutral.

Each icon remains an SVG with its existing size, events, forwarded ref and
caller-supplied labels/styles. Decorative Generic icons are aria-hidden.
Lucide stroke-width props do not apply to Ant Design's filled path definitions.
Outline thickness follows the official Ant Design assets.

When adding a new icon import, add a named original import, a named Ant SVG
definition import, and a pure `createThemedIcon` export in `index.jsx`. Avoid
namespace imports or runtime icon-name lookup in production: they prevent
tree shaking. `ThemedIcons.test.jsx` exercises every exported glyph and checks
family switching, SVG structure, events and accessibility.

Use the semantic exports in `crmIcons.jsx` when a shared symbol has different
meanings in different modules: `CrmSupport` is a headset (not a ticket/price
tag), `CrmDeals` is a pipeline board (not a shop/calendar), `CrmContacts` is
an address book (distinct from staff/team), and `CrmInvoice` is a document.
These choices are intentionally scoped to Generic navigation and dashboards.

Both icon families are separately budgeted. The additional Generic chunk is
approximately 48 kB gzipped on the initial build; it contains definitions,
not a second React instance or the Ant Design component framework.
