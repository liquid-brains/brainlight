#! /usr/bin/env ts-node

async function asleep(ms: number) {
	return(new Promise(resolve => setTimeout(resolve, ms)));
}

export type VielightRandomParams = {
	basename?: string;
	duration: number;
	freqMin: number;
	freqMax: number;
	couplingMin?: number;
	couplingMax?: number;
	couplingRandomDistribution?: number;
	powerMin: number;
	powerMax?: number;
}

export class VielightDevice {
	private ip: string;

	constructor(args: { ip: string; }) {
		this.ip = args.ip;
	}

	private async makeRequest(path: string, options?: { jsonResult?: boolean; query?: { [key: string]: string }; }): Promise<unknown> {
		const url = new URL(`http://${this.ip}/${path}`);
		if (options?.query) {
			for (const [key, value] of Object.entries(options.query)) {
				url.searchParams.append(key, value);
			}
		}

		console.log(`Making request to ${url.toString()}`);

		const response = await fetch(url);

		if (!response.ok) {
			throw(new Error(`Request failed with status ${response.status}: ${await response.text()}`));
		}

		if (options?.jsonResult === false) {
			return(await response.text());
		}

		return(await response.json());
	}

	async listFiles(limit?: 'vnp0' | 'vnp2'): Promise<string[]> {
		let resultRaw0: unknown = [];
		let resultRaw1: unknown = [];
		if (limit === undefined || limit === 'vnp0') {
			resultRaw0 = await this.makeRequest('getlistfile', { query: { msg: 'vnp0' } });
		}
		if (limit === undefined || limit === 'vnp2') {
			resultRaw1 = await this.makeRequest('getlistfile', { query: { msg: 'vnp2' } });
		}

		if (!Array.isArray(resultRaw0) || !Array.isArray(resultRaw1)) {
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

		const result = [...result0, ...result1];

		return(result);
	}

	async getFile(filename: string) {
		const data = await this.makeRequest('filedata', { query: { data: filename } });

		return(data);
	}

	private async saveFileNew(filename: string, data: unknown) {
		await this.makeRequest('filename', { jsonResult: false, query: { data: filename } });
		await this.makeRequest('savenewfile', { jsonResult: false, query: { data: JSON.stringify(data) } });

		const filelist = await this.listFiles('vnp0');
		await this.makeRequest('updatelistfile', { jsonResult: false, query: { data: JSON.stringify(filelist) } });

		return(true);
	}

	private async saveFileOverwrite(filename: string, data: unknown) {
		await this.makeRequest('filename', { jsonResult: false, query: { data: filename } });
		await this.makeRequest('datafileExisting', { jsonResult: false, query: { data: JSON.stringify(data) } });

		return(true);
	}

	async saveFile(filename: string, data: unknown) {
		if (typeof data !== 'object' || data === null) {
			throw(new Error('invalid data: not an object'));
		}
		if (!('filename' in data)) {
			throw(new Error('invalid data: no filename'));
		}

		data.filename = filename.replace(/\.vnp[0-9]$/, '');

		try {
			await this.saveFileNew(filename, data);
		} catch {
			await this.saveFileOverwrite(filename, data);
		}
	}

	async deleteFile(filename: string) {
		await this.makeRequest('deletefile', { jsonResult: false, query: { data: filename } });

		return(true);
	}

	async runFile(filename: string) {
		try {
			await this.makeRequest('stop', { jsonResult: false, query: { msg: 'Stop button pressed' } });
		} catch {
			/* Ignored */
		}
		await asleep(100);

		await this.makeRequest('filedatarun', { jsonResult: false, query: { data: filename } });


		await asleep(100);
		await this.makeRequest('run', { jsonResult: false, query: { msg: 'Run button pressed' } });
		//await this.makeRequest('runFreq', { jsonResult: false, query: { msg: 'Run button pressed' } });

		let errorCount = 0;
		let totalErrorCount = 0;
		for (;; await asleep(1000)) {
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

			if (errorCount > 5 || totalErrorCount > 10) {
				throw(new Error('Device not responding'));
			}

			if (statusCode === 'TOE') {
				/* Normal running code */
			} else if (statusCode === 'SPT') {
				break;
			} else {
				console.log(`Unknown status code: ${statusCode}`);
			}
		}
	}

	async runFileFromData(filename: string, data: unknown) {
		/*
		 * Delete the file before running it
		 */
		try {
			await this.deleteFile(filename);
		} catch {
			// Ignored
		}

		/*
		 * Save the file to the device.
		 */
		await this.saveFile(filename, data);

		/*
		 * Run the file on the device.
		 */
		await this.runFile(filename);
	}

	private generateRandomParams(filename: string, args: VielightRandomParams) {
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

		const frequency = randomValue(args.freqMin, args.freqMax);

		let crossCouplingFreq: number | undefined = undefined;
		if (args.couplingMin !== undefined) {
			crossCouplingFreq = randomValue(args.couplingMin, args.couplingMax);
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
				const distributionA = args.couplingRandomDistribution ?? 50;
				if (distributionA < 0 || distributionA > 100 || !Number.isSafeInteger(distributionA)) {
					throw(new Error('invalid cross coupling random distribution'));
				}
				return({
					"module_no": index + 1,
					"active": true,
					"activeRunTime": 1,
					"delayStartTime": 0,
					"moduleControl": {
						"phase": randomChoice([0, 1]),
						"dutyCycle": 5
					},
					"freq": frequency,
					"power": randomValue(args.powerMin, args.powerMax),
					"applyCross": randomChoice([applyCross, false], [distributionA, 100 - distributionA])
				})
			})
		});
	}

	async runRandom(args: VielightRandomParams) {
		const filenameGenerator = function(minute: number) {
			return(`${args.basename ?? 'random'}_${minute}.vnp0`);
		}

		for (let minute = 0; minute < args.duration; minute++) {
			const filename = filenameGenerator(minute);
			/*
			 * Create a file with random parameters and run it on the device.
			 */
			const data = this.generateRandomParams(filename, args);
			try {
				await this.deleteFile(filename);
			} catch {
				/* Ignore */
			}
			await this.saveFile(filename, data);
		}

		console.log('Running...');
		for (let minute = 0; minute < args.duration; minute++) {
			const filename = filenameGenerator(minute);

			let runFinished = false;
			await Promise.race([
				(async function() {
					await asleep(65_000);
					if (!runFinished) {
						console.log('Timeout reached');
					}
				})(),
				(async () => {
					await this.runFile(filename);
					runFinished = true;
				})()
			]);
		}
	}
}

