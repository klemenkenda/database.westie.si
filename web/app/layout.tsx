import type { Metadata } from "next";
import "./globals.css";
import ThemeToggle from "./ThemeToggle";

/* Runs before first paint, so a saved choice never flashes the other theme. With nothing
   saved no attribute is set and the stylesheet follows the OS. Lives here, not in the
   client component: a string exported from a "use client" module is not a string here. */
const themeScript = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export const metadata: Metadata = {
  title: "database.westie.si",
  description: "West Coast Swing video, ranked by the WSDC standing of the teachers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <header className="site">
          <a href="/" className="brand">database<span>.westie.si</span></a>
          <nav>
            <a href="/">Videos</a>
            <a href="/graph/">Graph builder</a>
            <a href="/graph/old/">Old graph</a>
          </nav>
          <ThemeToggle />
        </header>
        <main>{children}</main>
        <footer>
          Ranked by WSDC standing. Demoted sources sort last. Nothing here is treated as
          fact without provenance.
        </footer>
      </body>
    </html>
  );
}
