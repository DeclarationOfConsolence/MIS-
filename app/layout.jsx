import "./globals.css";

export const metadata = {
  title: "NapChief MIS Performance Dashboard",
  description: "Organization MIS tracking dashboard powered by Asana",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* apply saved theme before paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('mis-theme');if(t==='dark'){document.documentElement.classList.add('dark')}}catch(e){}`,
          }}
        />
      </head>
      <body className="font-sans antialiased bg-gray-50 text-gray-900 dark:bg-[#0a0a0a] dark:text-gray-100">
        {children}
      </body>
    </html>
  );
}
