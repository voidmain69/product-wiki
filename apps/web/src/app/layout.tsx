import type { ReactNode } from "react";

export const metadata = {
  title: "Вікіпедія товарів",
  description: "Достовірна інформація про товари з сайтів виробників",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uk">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0b0d10", color: "#e7eaee" }}>
        {children}
      </body>
    </html>
  );
}
