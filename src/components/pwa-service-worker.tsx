"use client";

import { useEffect } from "react";
import { registerKwingsMailServiceWorker } from "@/lib/push/client";

export function PwaServiceWorker() {
	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		void registerKwingsMailServiceWorker().catch((error) => {
			console.warn("Kwings Mail service worker registration failed", error);
		});
	}, []);

	return null;
}
