import "@shopify/ui-extensions/preact";
import { render } from "preact";

import App from "./App";

export default async function main() {
  render(<App />, document.body);
}
