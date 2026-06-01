export const getGuestToken = (): string => {
	const urlParams = new URLSearchParams(window.location.search);
	const urlToken = urlParams.get("token");
	const storedToken = localStorage.getItem("openparcels_guest_token");

	if (urlToken) {
		localStorage.setItem("openparcels_guest_token", urlToken);
		// Clean URL parameters to keep address bar clean
		window.history.replaceState({}, document.title, window.location.pathname);
		return urlToken;
	}

	return storedToken || "guest_secret_token";
};
