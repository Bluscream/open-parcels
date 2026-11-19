import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "dark" | "light";

const STORAGE_KEY = "open-parcels.theme";

function stored(): ThemeChoice {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "dark" || value === "light" ? value : "system";
}

/** The theme preference (not a secret) is the only thing the UI keeps in local storage. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(stored);
  useEffect(() => {
    if (choice === "system") {
      delete document.documentElement.dataset["theme"];
      localStorage.removeItem(STORAGE_KEY);
    } else {
      document.documentElement.dataset["theme"] = choice;
      localStorage.setItem(STORAGE_KEY, choice);
    }
  }, [choice]);
  return [choice, setChoice];
}
