import { URL } from "node:url";

type QueueItem = {
	fn: () => Promise<any>;
	resolve: (value: any) => void;
	reject: (reason: any) => void;
	addedAt: Date;
};

class RequestQueue {
	private queues = new Map<string, QueueItem[]>();
	private processing = new Set<string>();
	private lastRequestTimes = new Map<string, number>();

	private get intervalMs(): number {
		const val = process.env.OPENPARCELS_QUEUE_INTERVAL;
		const parsed = val ? parseInt(val, 10) : 60;
		return (Number.isNaN(parsed) ? 60 : parsed) * 1000;
	}

	public async enqueue<T>(url: string, fn: () => Promise<T>): Promise<T> {
		let domain = "unknown";
		try {
			const parsed = new URL(url);
			domain = parsed.hostname;
		} catch {
			domain = url;
		}

		return new Promise<T>((resolve, reject) => {
			if (!this.queues.has(domain)) {
				this.queues.set(domain, []);
			}
			const queue = this.queues.get(domain)!;
			queue.push({ fn, resolve, reject, addedAt: new Date() });
			console.log(`[RequestQueue] Domain "${domain}": Queued request. Current queue size: ${queue.length}`);

			this.processQueue(domain);
		});
	}

	private async processQueue(domain: string) {
		if (this.processing.has(domain)) {
			return;
		}
		const queue = this.queues.get(domain);
		if (!queue || queue.length === 0) {
			return;
		}

		this.processing.add(domain);

		while (queue.length > 0) {
			const item = queue[0];
			const lastTime = this.lastRequestTimes.get(domain) ?? 0;
			const now = Date.now();
			const elapsed = now - lastTime;
			const interval = this.intervalMs;

			if (elapsed < interval) {
				const waitTime = interval - elapsed;
				console.log(`[RequestQueue] Domain "${domain}": Waiting ${(waitTime / 1000).toFixed(1)}s before executing next request in queue (size: ${queue.length}).`);
				await new Promise((resolve) => setTimeout(resolve, waitTime));
			}

			// Dequeue and execute
			queue.shift();
			this.lastRequestTimes.set(domain, Date.now());
			console.log(`[RequestQueue] Domain "${domain}": Executing request. Next request to this domain allowed in ${(interval / 1000).toFixed(1)}s.`);

			try {
				const start = Date.now();
				const result = await item.fn();
				console.log(`[RequestQueue] Domain "${domain}": Request completed successfully in ${Date.now() - start}ms.`);
				item.resolve(result);
			} catch (err) {
				console.error(`[RequestQueue] Domain "${domain}": Request failed:`, err);
				item.reject(err);
			}
		}

		this.processing.delete(domain);
	}
}

export const requestQueue = new RequestQueue();
