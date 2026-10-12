import {
	createContext,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from "react";
import {
	applyTheme,
	readTheme,
	saveTheme,
	type ThemePreference,
} from "../theme";

const ThemeContext = createContext<{
	preference: ThemePreference;
	setPreference: (preference: ThemePreference) => void;
} | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [preference, setPreference] = useState(readTheme);
	useEffect(() => {
		applyTheme(preference);
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const update = () => applyTheme(preference);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, [preference]);
	return (
		<ThemeContext.Provider value={{
			preference,
			setPreference: (next) => {
				applyTheme(next);
				saveTheme(next);
				setPreference(next);
			},
		}}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme() {
	const theme = useContext(ThemeContext);
	if (!theme) throw new Error("useTheme requires ThemeProvider");
	return theme;
}
