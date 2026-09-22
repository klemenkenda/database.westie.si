import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "database.westie.si",
  description: "West Coast Swing video, ranked by the WSDC standing of the teachers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <a href="/" className="brand">database<span>.westie.si</span></a>
          <nav>
            <a href="/">Videos</a>
            <a href="/graph/">Graph studio</a>
          </nav>
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
