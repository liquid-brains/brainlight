#! /usr/bin/env ts-node

function sessionStoppedError(): Error {
	return(new Error('Session stopped.'));
}

async function asleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		throw(sessionStoppedError());
	}
	return(new Promise(function (resolve, reject): void {
		const timeoutID = setTimeout(function (): void {
			signal?.removeEventListener('abort', abort);
			resolve();
		}, ms);
		function abort(): void {
			clearTimeout(timeoutID);
			reject(sessionStoppedError());
		}
		signal?.addEventListener('abort', abort, { once: true });
	}));
}

function isBatchFile(filename: string, data?: unknown): boolean {
	/*
	 * Determine if we should fetch a batch file (vnp3/vnp4) or a
	 * single file (vnp0/vnp1/vnp2)
	 */

	let isBatch = false;
	if (filename.match(/\.vnp[34]$/)) {
		isBatch = true;
	}

	/*
	 * Verify that the contents match the isBatch determination if
	 * we have them
	 */
	if (data !== undefined) {
		if (typeof data !== 'object' || data === null) {
			throw(new Error('invalid data: not an object'));
		}
		if (!('single' in data)) {
			throw(new Error('invalid data: no "single"'));
		}

		if (typeof data.single !== 'boolean') {
			throw(new Error('invalid data: "single" is not a boolean'));
		}

		if (data.single && isBatch) {
			throw(new Error('invalid data: "single" is true but filename indicates batch file'));
		}
	}

	return(isBatch);
}

export type VielightRandomParams = {
	basename?: string;
	/**
	 * Duration of this journey (in minutes)
	 */
	duration: number;
	frequency: {
		ranges: {
			/**
			 * Minimum frequency to use within the session
			 */
			min: number;
			/**
			 * Maximum frequency to use within the session (default: same as min)
			 */
			max?: number;
		}[];

		/**
		 * Whether to generate a random frequency per-channel (true) or per session (e.g., minute) (false; default)
		 */
		perChannel?: boolean;
	};
	coupling?: {
		/**
		 * Cross-channel coupling minimum frequency to use within the session
		 */
		min: number;
		/**
		 * Cross-channel coupling minimum frequency to use within the session
		 */
		max?: number;
		/**
		 * Frequency distribution between cross-channel coupling and no cross-channel coupling (default: 50, meaning 50%)
		 */
		distribution?: number;
	};
	power: {
		/**
		 * Minimum power to use within the session
		 */
		min: number;
		/**
		 * Maximum power to use within the session (default: same as min)
		 */
		max?: number;
		/**
		 * Whether to generate a random power per-channel (true; default) or per session (e.g., minute) (false)
		 */
		perChannel?: boolean;
	};
}

export type VielightRunOptions = {
	signal?: AbortSignal;
	waitForCompletion?: boolean;
};

export type VielightDeviceEventPayloads = {
	'run-random-start': {
		fileCount: number;
	};
	'run-random-upload-start-file': {
		fileName: string;
		fileIndex: number;
		fileCount: number;
	};
	'run-randomupload-finish-file': {
		fileName: string;
		fileIndex: number;
		fileCount: number;
		data: Record<string, unknown>;
	};
	'run-random-run-start-file': {
		fileName: string;
		fileIndex: number;
		fileCount: number;
	};
	'run-random-run-finish-file': {
		fileName: string;
		fileIndex: number;
		fileCount: number;
	};
};

export type VielightDeviceEventListeners = {
	[EventName in keyof VielightDeviceEventPayloads]: (event: VielightDeviceEventPayloads[EventName]) => void;
};

export type VielightDeviceEventName = keyof VielightDeviceEventListeners;

type VielightDeviceArgs = {
	ip: string;
	/** default: no logger */
	logger?: Pick<typeof console, 'log' | 'error'>;
	/** default: fetch. If provided, this function will be used to make HTTP requests to the device. */
	fetch?: (input: URL) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown>; }>;
	/** default: true. If false, the fetch function is assumed to not return any data, and the makeRequest function will not attempt to read the response body. */
	fetchCanReturnData?: boolean;
};

export class VielightDevice {
	private ip: VielightDeviceArgs['ip'];
	private logger?: VielightDeviceArgs['logger'] | undefined;
	private fetch: NonNullable<VielightDeviceArgs['fetch']>;
	private fetchCanReturnData: NonNullable<VielightDeviceArgs['fetchCanReturnData']>;
	private eventListeners = new Map<VielightDeviceEventName, Map<symbol, unknown>>();

	constructor(args: VielightDeviceArgs) {
		this.ip = args.ip;
		this.logger = args.logger;
		this.fetch = args.fetch ?? async function(url) {
			return(await fetch(url));
		};
		this.fetchCanReturnData = args.fetchCanReturnData ?? true;
	}

	on<EventName extends VielightDeviceEventName>(eventName: EventName, listener: VielightDeviceEventListeners[EventName]): symbol {
		const listenerID = Symbol(eventName);
		let listeners = this.eventListeners.get(eventName);
		if (listeners === undefined) {
			listeners = new Map<symbol, unknown>();
			this.eventListeners.set(eventName, listeners);
		}
		listeners.set(listenerID, listener);
		return(listenerID);
	}

	off(listenerID: symbol): void {
		for (const listeners of this.eventListeners.values()) {
			if (listeners.delete(listenerID)) {
				return;
			}
		}
	}

	private emit<EventName extends VielightDeviceEventName>(eventName: EventName, event: VielightDeviceEventPayloads[EventName]): void {
		const listeners = this.eventListeners.get(eventName);
		if (listeners === undefined) {
			return;
		}
		for (const listener of listeners.values()) {
			const typedListener = listener as (event: VielightDeviceEventPayloads[EventName]) => void;
			typedListener(event);
		}
	}

	private async makeRequest(path: string, options?: { examineResult?: boolean; jsonResult?: boolean; query?: { [key: string]: string }; }): Promise<unknown> {
		const url = new URL(`http://${this.ip}/${path}`);
		options = { ...options };
		options.examineResult = options.examineResult ?? true;
		options.jsonResult = options.jsonResult ?? true;

		if (options?.query) {
			for (const [key, value] of Object.entries(options.query)) {
				url.searchParams.append(key, value);
			}
		}

		this.logger?.log(`Making request to ${url.toString()}`);

		const response = await this.fetch(url);

		if (!response.ok) {
			throw(new Error(`Request failed with status ${response.status}: ${await response.text()}`));
		}

		if (!options.examineResult) {
			return(null);
		}

		if (!this.fetchCanReturnData) {
			throw(new Error('Cannot examine result because fetch cannot return data'));
		}

		if (options.jsonResult) {
			return(await response.json());
		}

		return(await response.text());

	}

	async listFiles(limit?: 'vnp0' | 'vnp2' | 'vnp3' | ('vnp0' | 'vnp2' | 'vnp3')[]): Promise<string[]> {
		let resultRaw0: unknown = [];
		let resultRaw1: unknown = [];
		let resultRaw2: unknown = [];

		function has(kind: 'vnp0' | 'vnp2' | 'vnp3'): boolean {
			if (limit === undefined) {
				if (kind === 'vnp3') {
					return(false);
				}
				return(true);
			}
			if (typeof limit === 'string') {
				return(limit === kind);
			}
			if (Array.isArray(limit)) {
				return(limit.includes(kind));
			}
			throw(new Error('Unexpected limit type'));
		}

		if (has('vnp0')) {
			resultRaw0 = await this.makeRequest('getlistfile', { query: { msg: 'vnp0' } });
		}
		if (has('vnp2')) {
			resultRaw1 = await this.makeRequest('getlistfile', { query: { msg: 'vnp2' } });
		}
		if (has('vnp3')) {
			resultRaw2 = await this.makeRequest('getlistbatchfile', { query: { msg: 'get listbatchfile' } });
		}

		if (!Array.isArray(resultRaw0) || !Array.isArray(resultRaw1) || !Array.isArray(resultRaw2)) {
			throw new Error('Unexpected response format');
		}

		const filter = function(item: unknown): item is string {
			if (typeof item !== 'string') {
				throw new Error('Unexpected item format');
			}
			return(true);
		};
		const result0 = resultRaw0.filter(filter);
		const result1 = resultRaw1.filter(filter);
		const result2 = resultRaw2.filter(filter);

		const result = [...result0, ...result1, ...result2];

		return(result);
	}

	async getFile(filename: string) {
		if (!isBatchFile(filename)) {
			const data = await this.makeRequest('filedata', { query: { data: filename } });

			return(data);
		} else {
			const data = await this.makeRequest('batchfiledata', { query: { data: filename } });

			return(data);
		}
	}

	private async saveFileNew(filename: string, data: unknown) {
		await this.makeRequest('filename', { examineResult: false, query: { data: filename } });
		await this.makeRequest('savenewfile', { examineResult: false, query: { data: JSON.stringify(data) } });

		try {
			const filelist = await this.listFiles('vnp0');
			await this.makeRequest('updatelistfile', { examineResult: false, query: { data: JSON.stringify(filelist) } });
		} catch {
			/*
			 * Ignore errors in case we can't list files
			 */
		}

		return(true);
	}

	private async saveFileOverwrite(filename: string, data: unknown) {
		await this.makeRequest('filename', { examineResult: false, query: { data: filename } });
		await this.makeRequest('datafileExisting', { examineResult: false, query: { data: JSON.stringify(data) } });

		return(true);
	}

	private async saveBatchFileNew(filename: string, data: unknown) {
		await this.makeRequest('batchfilename', { examineResult: false, query: { data: filename } });
		await this.makeRequest('savenewbatchfile', { examineResult: false, query: { data: JSON.stringify(data) } });

		try {
			const filelist = await this.listFiles('vnp3');
			await this.makeRequest('updatelistbatchfile', { examineResult: false, query: { data: JSON.stringify(filelist) } });
		} catch {
			/*
			 * Ignore errors in case we can't list files
			 */
		}

		if (typeof data !== 'object' || data === null) {
			return(true);
		}

		if (!('filenames' in data) || !Array.isArray(data.filenames)) {
			return(true);
		}

		for (const filename of data.filenames) {
			if (typeof filename !== 'string' || filename === '') {
				continue;
			}

			await this.makeRequest('usedBatchFileTrue', { examineResult: false, query: { data: filename } });
		}


		return(true);
	}

	private async saveBatchFileOverwrite(filename: string, data: unknown) {
		await this.makeRequest('batchfilename', { examineResult: false, query: { data: filename } });
		await this.makeRequest('batchdatafileExisting', { examineResult: false, query: { data: JSON.stringify(data) } });
/* XXX:TODO: Should we usedBatchFileFalse?data=<filename>   for any files removed ?   We can't always read the old value */
/* XXX:TODO: Should we usedBatchFileTrue?data=<filename>   for any files added ?   We can't always read the old value */

		return(true);
	}

	async saveFile(filename: string, data: unknown, force = false) {
		if (typeof data !== 'object' || data === null) {
			throw(new Error('invalid data: not an object'));
		}
		if (!('filename' in data)) {
			throw(new Error('invalid data: no filename'));
		}

		data.filename = filename.replace(/\.vnp[0-9]$/, '');

		if (isBatchFile(filename, data)) {
			try {
				await this.saveBatchFileNew(filename, data);
			} catch {
				force = true;
			}

			if (force) {
				await this.saveBatchFileOverwrite(filename, data);
			}

			return;
		}

		try {
			await this.saveFileNew(filename, data);
		} catch {
			force = true;
		}

		if (force) {
			await this.saveFileOverwrite(filename, data);
		}

		return(true);
	}

	private async deleteSingleFile(filename: string) {
		await this.makeRequest('deletefile', { examineResult: false, query: { data: filename } });

		return(true);
	}

	private async deleteBatchFile(filename: string) {
		await this.makeRequest('deletebatchModule', { examineResult: false, query: { data: filename } });

		try {
			const filelist = await this.listFiles('vnp3');
			await this.makeRequest('updatelistbatchfile', { examineResult: false, query: { data: JSON.stringify(filelist) } });
		} catch {
			/*
			 * Ignore errors in case we can't list files
			 */
		}

		return(true);
	}

	async deleteFile(filename: string) {
		if (isBatchFile(filename)) {
			return(await this.deleteBatchFile(filename));
		}

		return(await this.deleteSingleFile(filename));
	}

	async stop(): Promise<void> {
		await this.makeRequest('stop', { examineResult: false, query: { msg: 'Stop button pressed' } });
	}

	private throwIfStopped(signal?: AbortSignal): void {
		if (signal?.aborted) {
			throw(sessionStoppedError());
		}
	}

	async runFile(filename: string, options?: VielightRunOptions) {
		options = { ...options };
		options.waitForCompletion = options.waitForCompletion ?? true;

		this.throwIfStopped(options?.signal);
		try {
			await this.stop();
		} catch {
			/* Ignored */
		}
		await asleep(100, options?.signal);

		this.throwIfStopped(options?.signal);
		await this.makeRequest('filedatarun', { examineResult: false, query: { data: filename } });

		await asleep(100, options?.signal);
		this.throwIfStopped(options?.signal);
		await this.makeRequest('run', { examineResult: false, query: { msg: 'Run button pressed' } });
		//await this.makeRequest('runFreq', { jsonResult: false, query: { msg: 'Run button pressed' } });

		if (!options.waitForCompletion) {
			return;
		}

		let errorCount = 0;
		let totalErrorCount = 0;
		for (;;) {
			await asleep(1000, options?.signal);
			this.throwIfStopped(options?.signal);
			let statusCode = 'UNK';
			try {
				const status = await this.makeRequest('activate', { jsonResult: false, query: { msg: 'Waiting for ending respond' } });
				if (typeof status !== 'string') {
					throw(new Error('Unexpected response format'));
				}

				statusCode = status.slice(0, 3);
				errorCount = 0;
			} catch {
				errorCount++;
				totalErrorCount++;
			}
			this.throwIfStopped(options?.signal);

			if (errorCount > 5 || totalErrorCount > 10) {
				throw(new Error('Device not responding'));
			}

			if (statusCode === 'TOE') {
				/* Normal running code */
			} else if (statusCode === 'SPT') {
				break;
			} else {
				this.logger?.log(`Unknown status code: ${statusCode}`);
			}
		}
	}

	async runFileFromData(filename: string, data: unknown, options?: VielightRunOptions) {
		const stopDevice = (): void => {
			void this.stop().catch(function (): void {
				/* The local run still ends when the device is unreachable. */
			});
		};
		options?.signal?.addEventListener('abort', stopDevice, { once: true });
		if (options?.signal?.aborted) {
			stopDevice();
		}
		try {
			try {
				await this.deleteFile(filename);
			} catch {
				/* Ignored */
			}
			this.throwIfStopped(options?.signal);
			await this.saveFile(filename, data);
			await this.runFile(filename, options);
		} finally {
			options?.signal?.removeEventListener('abort', stopDevice);
		}
	}

	static generateRandomParams(filename: string, args: VielightRandomParams) {
		args.power.perChannel ??= true;
		args.frequency.perChannel ??= false;

		const randomValue = function(min: number, max?: number): number {
			if (max === undefined) {
				return(min);
			}

			const computedRandomValue = Math.floor(Math.random() * (max - min + 1)) + min;
			return(computedRandomValue);
		}

		const randomChoice = function<T>(choices: T[], weights?: number[]): T {
			if (weights === undefined) {
				weights = new Array(choices.length).fill(1);
			}

			const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
			const randomValue = Math.random() * totalWeight;

			if (choices.length !== weights.length) {
				throw(new Error('Choices and weights arrays must have the same length'));
			}

			let cumulativeWeight = 0;
			for (let i = 0; i < choices.length; i++) {
				cumulativeWeight += weights[i]!;
				if (randomValue < cumulativeWeight) {
					return(choices[i]!);
				}
			}

			return(choices[choices.length - 1]!);
		}

		const randomFrequency = function(ranges: { min: number; max?: number; }[]): number {
			if (ranges.length === 0) {
				throw(new Error('No frequency ranges provided'));
			}

			/* Compute the total number of frequencies in all ranges */
			const totalFrequencies = ranges.reduce((sum, range) => {
				const max = range.max ?? range.min;
				return sum + (max - range.min + 1);
			}, 0);

			/* Choose a random frequency index */
			const randomIndex = Math.floor(Math.random() * totalFrequencies);

			/* Find the corresponding frequency in the ranges */
			let cumulativeFrequencies = 0;
			for (const range of ranges) {
				const max = range.max ?? range.min;
				const rangeSize = max - range.min + 1;

				if (randomIndex < cumulativeFrequencies + rangeSize) {
					return(range.min + (randomIndex - cumulativeFrequencies));
				}

				cumulativeFrequencies += rangeSize;
			}

			return(ranges[0]!.min);
		};

		const sessionAllChannelsPower =  randomValue(args.power.min, args.power.max);
		const sessionAllChannelFrequency = randomFrequency(args.frequency.ranges);

		let crossCouplingFreq: number | undefined = undefined;
		if (args.coupling !== undefined) {
			crossCouplingFreq = randomValue(args.coupling.min, args.coupling.max);
		}

		const crossCouplingInfo = (function() {
			if (crossCouplingFreq === undefined) {
				return({
					"active": false,
					"freq": null,
					"couplingDelay": null,
					"stopCoupling": null
				});
			}

			return({
				"active": true,
				"freq": crossCouplingFreq,
				"couplingDelay": 0,
				"stopCoupling": 1 
			});
		})();

		return({
			"defaultFile": false,
			"secretFile": false,
			"usedByBatch": 0,
			"single": true,
			"updateExisting": true,
			"saveNew": false,
			"filename": filename.replace(/\.vnp0$/, ''),
			"notes": 'Randomly generated file',
			"frequency": {
				"active": false,
				"startFreq": null,
				"endFreq": null,
				"freqStepSize": null,
				"stepDuration": null
			},
			"power": {
				"active": false,
				"startPower": null,
				"endPower": null,
				"powerStepSize": null,
				"stepDuration": null
			},
			"cross": crossCouplingInfo,
			"modules": new Array(12).fill(null).map(function(_, index) {
				const applyCross = crossCouplingInfo.active;
				const distributionA = args.coupling?.distribution ?? 50;

				if (distributionA < 0 || distributionA > 100 || !Number.isSafeInteger(distributionA)) {
					throw(new Error('invalid cross coupling random distribution'));
				}

				const modulePower = (function() {
					if (args.power.perChannel) {
						return(randomValue(args.power.min, args.power.max));
					}

					return(sessionAllChannelsPower);
				})();

				const moduleFrequency = (function() {
					if (args.frequency.perChannel) {
						return(randomFrequency(args.frequency.ranges));
					}

					return(sessionAllChannelFrequency);
				})();

				return({
					"module_no": index + 1,
					"active": true,
					"activeRunTime": 1,
					"delayStartTime": 0,
					"moduleControl": {
						"phase": randomChoice([0, 1]),
						"dutyCycle": 5
					},
					"freq": moduleFrequency,
					"power": modulePower,
					"applyCross": randomChoice([applyCross, false], [distributionA, 100 - distributionA])
				})
			})
		});
	}

	async runRandom(args: VielightRandomParams, options?: VielightRunOptions) {
		const stopDevice = (): void => {
			void this.stop().catch(function (): void {
				/* The local loop still stops when the device is unreachable. */
			});
		};
		options?.signal?.addEventListener('abort', stopDevice, { once: true });
		if (options?.signal?.aborted) {
			stopDevice();
		}
		const filenameGenerator = function(minute: number) {
			return(`${args.basename ?? 'random'}_${minute}.vnp0`);
		};
		try {
			this.throwIfStopped(options?.signal);
			this.emit('run-random-start', { fileCount: args.duration });
			for (let minute = 0; minute < args.duration; minute++) {
				this.throwIfStopped(options?.signal);
				const filename = filenameGenerator(minute);
				const fileEvent = { fileName: filename, fileIndex: minute + 1, fileCount: args.duration };
				this.emit('run-random-upload-start-file', fileEvent);
				const data = VielightDevice.generateRandomParams(filename, args);
				try {
					await this.deleteFile(filename);
				} catch {
					/* Ignore */
				}
				this.throwIfStopped(options?.signal);
				await this.saveFile(filename, data);
				this.emit('run-randomupload-finish-file', { ...fileEvent, data: data });
			}

			this.logger?.log('Running...');
			for (let minute = 0; minute < args.duration; minute++) {
				this.throwIfStopped(options?.signal);
				const filename = filenameGenerator(minute);
				const fileEvent = { fileName: filename, fileIndex: minute + 1, fileCount: args.duration };
				let runFinished = false;
				let timeoutID: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						new Promise<void>((resolve) => {
							timeoutID = setTimeout(() => {
								if (!runFinished) {
									this.logger?.log('Timeout reached');
								}
								resolve();
							}, 65_000);
						}),
						(async () => {
							this.emit('run-random-run-start-file', fileEvent);
							await this.runFile(filename, {
								...options,
								waitForCompletion: true
							});
							runFinished = true;
							this.emit('run-random-run-finish-file', fileEvent);
						})()
					]);
				} finally {
					if (timeoutID !== undefined) {
						clearTimeout(timeoutID);
					}
				}
			}
		} finally {
			options?.signal?.removeEventListener('abort', stopDevice);
		}
	}
}
