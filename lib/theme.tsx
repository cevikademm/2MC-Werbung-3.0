import React, { createContext, useState, useContext, useEffect } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// HTML element'inde dark class'ını set/unset et + body inline style'ını
// tema bazlı renkle değiştir. index.html'de body için hardcoded
// bg-color/color var; CSS override'lar :root'a göre çalışsın diye class'ı
// html element'inde tutuyoruz (Tailwind config darkMode: 'class' ile uyumlu).
const applyThemeToDocument = (theme: Theme) => {
  const html = document.documentElement;
  if (theme === 'dark') {
    html.classList.add('dark');
    html.classList.remove('light');
  } else {
    html.classList.add('light');
    html.classList.remove('dark');
  }
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem('app_theme');
    return stored === 'light' ? 'light' : 'dark';
  });

  // Sayfa yüklenirken ve tema değişirken HTML class'ını uyumla
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem('app_theme', t);
  };

  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
};
