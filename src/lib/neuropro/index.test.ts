import { strict as assert } from 'node:assert';
import test from 'node:test';

import { VielightDevice } from './index.js';

test('runRandom reports upload and run events and removes listeners', async function () {
	const device = new VielightDevice({ ip: '127.0.0.1' });
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
	device.on('run-randomupload-finish-file', function (): void {
		reportedEvents.push('run-randomupload-finish-file');
	});
	device.on('run-random-run-start-file', function (): void {
		reportedEvents.push('run-random-run-start-file');
	});
	device.on('run-random-run-finish-file', function (): void {
		reportedEvents.push('run-random-run-finish-file');
	});

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async function (input): Promise<Response> {
		const requestURL = new URL(String(input));
		if (requestURL.pathname === '/getlistfile') {
			return(new Response('[]', { status: 200 }));
		}
		if (requestURL.pathname === '/activate') {
			return(new Response('SPT', { status: 200 }));
		}
		return(new Response('', { status: 200 }));
	};
	try {
		await device.runRandom({ duration: 1, freqMin: 10, powerMin: 1 });
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.deepEqual(reportedEvents, [
		'run-random-start',
		'run-random-upload-start-file',
		'run-randomupload-finish-file',
		'run-random-run-start-file',
		'run-random-run-finish-file'
	]);
});

test('runRandom stops the device and rejects when its signal is aborted', async function () {
	const device = new VielightDevice({ ip: '127.0.0.1' });
	const controller = new AbortController();
	let stopRequests = 0;
	device.on('run-random-run-start-file', function (): void {
		controller.abort();
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async function (input): Promise<Response> {
		const requestURL = new URL(String(input));
		if (requestURL.pathname === '/getlistfile') {
			return(new Response('[]', { status: 200 }));
		}
		if (requestURL.pathname === '/stop') {
			stopRequests++;
		}
		return(new Response('', { status: 200 }));
	};
	try {
		await assert.rejects(
			device.runRandom({ duration: 1, freqMin: 10, powerMin: 1 }, { signal: controller.signal }),
			/Session stopped\./
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(stopRequests, 1);
});
