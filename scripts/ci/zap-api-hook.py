"""zap-api-scan.py hook (task 13.13, `002` VCDM M18).

No ZAP report template lists messages that raised no alert (a 2xx raises
none), and the `-J` report carries no headers. Just before ZAP shuts down,
the hook writes every history message's request line and status line to
`REPORT_FILE`, which `scripts/ci/dast-coverage.ts` reads. Only the first line
of each header is kept, so no cookie or other header value reaches the file.
The hook sends no request of its own: every message is one ZAP generated, and
`scripts/ci/zap-seed.ts` seeds the resources ZAP's placeholder path
parameters (`blueprint`, `entity`) name, so those requests can succeed.
"""

import json

REPORT_FILE = '/zap/wrk/api_messages.json'


def _first_line(header):
    return header.split('\r\n', 1)[0]


def zap_pre_shutdown(zap):
    messages = [
        {
            'requestHeader': _first_line(message['requestHeader']),
            'responseHeader': _first_line(message['responseHeader']),
        }
        for message in zap.core.messages()
    ]
    with open(REPORT_FILE, 'w') as report:
        json.dump({'messages': messages}, report)
