import page from "./inspect.html";
import type { Store } from "./store";
import { serveWeb } from "./web";

// Local web viewer for browsing, adding, editing, moving, retiring and deleting entries, as a list.
export const inspect = (store: Store, port = 0) => serveWeb(store, page, port);
