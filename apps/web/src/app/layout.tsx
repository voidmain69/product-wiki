import type { ReactNode } from "react";

export const metadata = {
  title: "Вікіпедія товарів",
  description: "Достовірна інформація про товари з сайтів виробників",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uk">
      <head>
        {/* Шрифти дизайну Hi-Fi: IBM Plex Sans (текст) + Source Serif 4 (заголовки), кириличний сабсет. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,600&display=swap&subset=cyrillic"
          rel="stylesheet"
        />
      </head>
      <body style={{ margin: 0, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", background: "#0b0d10", color: "#e7eaee" }}>
        {children}
      </body>
    </html>
  );
}
