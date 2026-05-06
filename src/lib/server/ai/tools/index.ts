/**
 * Tool registration entry point. Importing this file registers every AI
 * tool itcake exposes. Sessions resolve tool definitions via the registry,
 * so by the time `streamSessionTurn` runs, the registry is populated.
 *
 * Add a new tool: create a file under tools/ that calls `registerTool`,
 * then import it here.
 */
import './agents.js';
import './backup.js';
