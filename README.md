<img src="admin/healthchecks.png" width="64">

# ioBroker.healthchecks

This Adapter interacts with the healthchecks.io API. Either with a [self-hosted server](https://github.com/healthchecks/healthchecks) or with the official [healthchecks.io](https://healthchecks.io/) server. The adapter can be used to create a device availability/health overview, or to manage and integrate other healthchecks.

It is assumed, that check names are unique (excluding checks that do not have a name).

## Setup

Just add the API server, ping server and a read/write API key to the instance settings. Note, that self-hosted ping servers usually have a "/ping" ending.

  
## Changelog

### 0.1.0
* (TyrionWarMage) Initial release


## License
MIT License

Copyright (c) 2022 TyrionWarMage

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
