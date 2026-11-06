import page from "./tree.html";
import type { Store } from "./store";
import { serveWeb } from "./web";

// Local web editor that shows every scope, project and entry as one collapsible tree.
export const tree = (store: Store, port = 0) => serveWeb(store, page, port);
