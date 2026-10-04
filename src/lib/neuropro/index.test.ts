import { strict as assert } from 'node:assert';
import test from 'node:test';

import { VielightDevice } from './index.js';

test('uses the supplied fetch to retrieve files', async function () {
	const requestedURLs: URL[] = [];
	const device = new VielightDevice({
		ip: '192.0.2.1:8080',
		fetch: async function (input): Promise<Response> {
			requestedURLs.push(input);
			return(new Response(JSON.stringify(['one.vnp0']), { status: 200 }));
		}
	});

	const files = await device.listFiles('vnp0');

	assert.deepEqual(files, ['one.vnp0']);
	assert.equal(requestedURLs.length, 1);
	assert.equal(requestedURLs[0]?.toString(), 'http://192.0.2.1:8080/getlistfile?msg=vnp0');
});

test('uses a fetch without response data for write-only requests', async function () {
	const requestedURLs: URL[] = [];
	const device = new VielightDevice({
		ip: '127.0.0.1',
		fetchCanReturnData: false,
		fetch: async function (input) {
			requestedURLs.push(input);
			return({
				ok: true,
				status: 200,
				text: async function (): Promise<string> {
					assert.fail('Write-only requests must not read response text.');
				},
				json: async function (): Promise<unknown> {
					assert.fail('Write-only requests must not read response JSON.');
				}
			});
		}
	});

	await device.stop();
	await device.deleteFile('old.vnp0');
	await device.runFile('run.vnp0', { waitForCompletion: false });

	assert.deepEqual(
		requestedURLs.map(function (url): string {
			return(url.toString());
		}),
		[
			'http://127.0.0.1/stop?msg=Stop+button+pressed',
			'http://127.0.0.1/deletefile?data=old.vnp0',
			'http://127.0.0.1/stop?msg=Stop+button+pressed',
			'http://127.0.0.1/filedatarun?data=run.vnp0',
			'http://127.0.0.1/run?msg=Run+button+pressed'
		]
	);
});

test('rejects result-reading requests when fetch cannot return data', async function () {
	const device = new VielightDevice({
		ip: '127.0.0.1',
		fetchCanReturnData: false,
		fetch: async function () {
			return({
				ok: true,
				status: 200,
				text: async function (): Promise<string> {
					assert.fail('Successful requests must not read response text before rejecting.');
				},
				json: async function (): Promise<unknown> {
					assert.fail('Successful requests must not read response JSON before rejecting.');
				}
			});
		}
	});

	await assert.rejects(device.listFiles('vnp0'), /Cannot examine result because fetch cannot return data/);
});

test('runRandom reports upload and run events and removes listeners', async function () {
	const device = new VielightDevice({
		ip: '127.0.0.1',
		fetch: async function (input): Promise<Response> {
			const requestURL = new URL(input);
			if (requestURL.pathname === '/getlistfile') {
				return(new Response('[]', { status: 200 }));
			}
			if (requestURL.pathname === '/activate') {
				return(new Response('SPT', { status: 200 }));
			}
			return(new Response('', { status: 200 }));
		}
	});
	const reportedEvents: string[] = [];
	const removedListenerID = device.on('run-random-start', function (): void {
		assert.fail('Removed listener was called.');
	});
	device.off(removedListenerID);
	device.on('run-random-start', function (event): void {
		assert.equal(event.fileCount, 1);
		reportedEvents.push('run-random-start');
	});
	device.on('run-random-upload-start-file', function (event): void {
		assert.equal(event.fileIndex, 1);
		reportedEvents.push('run-random-upload-start-file');
	});
	device.on('run-randomupload-finish-file', function (event): void {
		assert.equal(event.data.modules instanceof Array, true);
		reportedEvents.push('run-randomupload-finish-file');
	});
	device.on('run-random-run-start-file', function (): void {
		reportedEvents.push('run-random-run-start-file');
	});
	device.on('run-random-run-finish-file', function (): void {
		reportedEvents.push('run-random-run-finish-file');
	});

	await device.runRandom({ duration: 1, freqMin: 10, powerMin: 1 });

	assert.deepEqual(reportedEvents, [
		'run-random-start',
		'run-random-upload-start-file',
		'run-randomupload-finish-file',
		'run-random-run-start-file',
		'run-random-run-finish-file'
	]);
});

test('runRandom stops the device and rejects when its signal is aborted', async function () {
	const device = new VielightDevice({
		ip: '127.0.0.1',
		fetch: async function (input): Promise<Response> {
			const requestURL = new URL(input);
			if (requestURL.pathname === '/getlistfile') {
				return(new Response('[]', { status: 200 }));
			}
			if (requestURL.pathname === '/stop') {
				stopRequests++;
			}
			return(new Response('', { status: 200 }));
		}
	});

	const controller = new AbortController();
	let stopRequests = 0;
	device.on('run-random-run-start-file', function (): void {
		controller.abort();
	});

	await assert.rejects(
		device.runRandom({ duration: 1, freqMin: 10, powerMin: 1 }, { signal: controller.signal }),
		/Session stopped\./
	);
	assert.equal(stopRequests, 1);
});
