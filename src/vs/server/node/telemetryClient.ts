import { AppInsightsCore, IExtendedTelemetryItem, ITelemetryItem } from '@microsoft/1ds-core-js';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';

export class TelemetryClient extends AppInsightsCore {
	public constructor(private readonly endpoint: string) {
		super();
	}

	public override track(item: IExtendedTelemetryItem | ITelemetryItem): void {
		const options = item.baseData || {}
		if (!options.properties) {
			options.properties = {};
		}
		if (!options.measurements) {
			options.measurements = {};
		}

		try {
			const cpus = os.cpus();
			options.measurements.cores = cpus.length;
			options.properties['common.cpuModel'] = cpus[0].model;
		} catch (error) {}

		try {
			options.measurements.memoryFree = os.freemem();
			options.measurements.memoryTotal = os.totalmem();
		} catch (error) {}

		try {
			options.properties['common.shell'] = os.userInfo().shell;
			options.properties['common.release'] = os.release();
			options.properties['common.arch'] = os.arch();
		} catch (error) {}

		try {
			const request = (/^http:/.test(this.endpoint) ? http : https).request(this.endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
			});
			request.on('error', () => { /* We don't care. */ });
			request.write(JSON.stringify(options));
			request.end();
		} catch (error) {}
	}
}
