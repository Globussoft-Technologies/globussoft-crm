/** Default built-in tools and a registry factory. */
import { ToolRegistry } from '../registry.js';
import type { Tool } from '../types.js';
import { delegateTool } from './delegate.js';
import { webFetchTool } from './web-fetch.js';
import { imageSearchTool } from './image-search.js';
import { mapRouteTool } from './map-route.js';

/**
 * Tools available to every sector by default. Note: PDF rendering is NOT a tool
 * — a designer agent outputs HTML and the orchestrator renders it post-run via
 * renderHtmlToArtifact (see packages/tools/src/render.ts). Putting large HTML in
 * a tool-call argument makes models loop and overflow the context. `image_search`
 * IS safe as a tool because it returns only short URL lists, not HTML.
 */
export const builtinTools: Tool[] = [delegateTool, webFetchTool, imageSearchTool, mapRouteTool];

/** A registry pre-loaded with the built-ins. Extend per sector as needed. */
export function buildDefaultRegistry(extra: Tool[] = []): ToolRegistry {
  return new ToolRegistry().registerAll([...builtinTools, ...extra]);
}

export { delegateTool, webFetchTool, imageSearchTool, mapRouteTool };
