import { Header } from "./components/Header";
import { Host } from "./pages/Host";
import { Logs } from "./pages/Logs";
import { Overview } from "./pages/Overview";
import { usePath } from "./router";

export function App() {
  const path = usePath();
  let page;
  const m = path.match(/^\/hosts\/([^/]+)$/);
  if (m) page = <Host key={m[1]} host={decodeURIComponent(m[1])} />;
  else if (path.startsWith("/logs")) page = <Logs />;
  else page = <Overview />;
  return (
    <>
      <Header path={path} />
      {page}
    </>
  );
}
