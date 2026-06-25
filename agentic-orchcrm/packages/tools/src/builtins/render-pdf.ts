/**
 * @deprecated render_pdf is no longer an agent tool — passing large HTML through
 * a tool-call argument makes models loop and overflows the context. A designer
 * agent now outputs HTML and the orchestrator renders it post-run.
 * Use {@link renderHtmlToArtifact} from `@agentic-os/tools` instead.
 */
export { renderHtmlToArtifact } from '../render.js';
