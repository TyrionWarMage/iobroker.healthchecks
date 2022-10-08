"use strict";

/*
 * Created with @iobroker/create-adapter v1.23.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const request = require("request");
const {
  HealthChecksPingClient,
  HealthChecksApiClient
} = require('healthchecks-io-client');

// eslint-disable-next-line no-unused-vars
let tmr_GetValues = null;

let apiclient = null;
// Load your modules here, e.g.:
// const fs = require("fs");

class Healthchecks extends utils.Adapter {
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        // @ts-ignore
        super({
            ...options,
            name: "healthchecks",
        });
        this.on("ready", this.onReady.bind(this));
        //this.on("objectChange", this.onObjectChange.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    decrypt(key, value) {
        let result = "";
        for (let i = 0; i < value.length; ++i) {
            result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
        }
        this.log.debug("client_secret decrypt ready");
        return result;
    }

    replaceAll(str, find, replace) {
        return str.replace(new RegExp(find, "g"), replace);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        let bPreCheckErr = false;   //We can't stop the adapter since we need it 4 url and auth check. Make preCheck, if error found don't run main functions 

        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);

        this.log.debug("Verify config");
        
        //Check refresh interval field, if its's not set, we set it
        if (!Number.isInteger(this.config.inp_refresh)) {
            this.config.inp_refresh = 5;
            this.log.info("Update-Interval set to " + this.config.inp_refresh.toString());
        }
        //Check path field, if it's not set, we dont run
        if (this.config.inp_url.length == 0) {
            this.log.info("URL not set, abort!");
            bPreCheckErr = true;  //Dont run
        }

        //Get encrypted Password
        const oConf = await this.getForeignObjectAsync("system.config");
        if (oConf && oConf.native && oConf.native.secret) {
            // @ts-ignore
            this.apikey = this.decrypt(oConf.native.secret, this.config.inp_apikey);
        } else {
            this.apikey = this.decrypt("Zgfr56gFe87jJOM", this.config.inp_apikey);
        }
        this.log.debug("Decrypted the encrypted api key!");

        if (!bPreCheckErr) {
            //Get first Time Token
            this.client = this.initClient(this.config.inp_url,this.apikey);
            this.getHealthChecks(this.client)
            //Then begin Update Timer
            this.getValues();
        } else {
            this.log.error("##### PRE CHECK ERRORS, MAIN FUNCTIONS DISABLED! Check Settings");
        }
        
        //Object2SendCMD
        this.setObjectNotExists("sendCommand", {
            type: "state",
            common: { name: "sendCommand", type: "string", role: "text", write: true},
            native: {}  
        }, (id, error) => {this.setState("sendCommand", "", true);});
        
        //Object2WriteResult
        this.setObjectNotExists("sendCommandLastResult", {
            type: "state",
            common: { name: "sendCommand", type: "string", role: "text", write: false},
            native: {}  
        }, (id, error) => {this.setState("sendCommandLastResult", "", true);});

        this.getDevices((err,devices) => {
            const device_list = this.config.list_commands.map(entry => {return entry.alias});
            device_list.forEach(device => {
                this.setObjectNotExists(device, {
                    type: "device",
                    common: { name: device},
                    native: {}                  
                });                
            });
            devices.forEach(device => {
                const device_name = device._id.replace(this.namespace+".","");
                if (!device_list.includes(device_name)) {
                    this.delObject(device_name, {recursive: true})
                }
            })
        });
           
                       
        this.subscribeStates("*");
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            if (tmr_GetValues) {
                clearInterval(tmr_GetValues);
                tmr_GetValues = null;
            }
            this.log.info("cleaned everything up...");
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
    // * Is called if a subscribed object changes
    // * @param {string} id
    // * @param {ioBroker.Object | null | undefined} obj
    */

    /*onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }*/

    /**
    //  * Is called if a subscribed state changes
    // * @param {string} id
    //* @param {ioBroker.State | null | undefined} state
    */

    onStateChange(id, state) {
        if (state) {
            // The state was changed
            if (id == this.namespace + ".sendCommand" && state.val) { //& value not "" empty 
                this.log.debug("SendCommand: " + state.val);
                this.fHTTPSendCommand(state.val, true);
                this.setState("sendCommand", "");
            }
        } else {
            // The state was deleted
            this.log.debug(`state ${id} deleted`);
        }
    }

    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.message" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    async onMessage(obj) {
        this.log.debug("message handling: " + obj);
        if (typeof obj === "object") {
            //Check if AUTH OK
            if (obj.command === "checkLogin") {
                //save Command Result true/false
                const check_result = await this.checkLogin(obj.message);
                //send Result back
                if (obj.callback) this.sendTo(obj.from, obj.command, check_result.toString(), obj.callback);
            }
        }
    }

    async checkLogin(oCheckVals) {
        this.log.debug("tryLogin: " + oCheckVals); 
        try {
            const client = this.initClient(oCheckVals.base_url,oCheckVals.apikey);
            const checks = await this.getHealthChecks(client);
            if (checks !== null) {
                return true;
            }   
        } catch(err) {
            this.log.error("tryLogin failed: " + err);   
        }
        return false;
    }


    async fValidateHTTPResult(error, response, sFuncName) {
        if (error) {
            this.log.warn("##### fHTTP" + sFuncName + " ERROR: " + error.toString());
            return false;  //Error
        } else {
            if (!(response.statusCode == 200)) {
                this.log.debug("##### fHTTP" + sFuncName + " HTTPCode: " + response.statusCode);
                if (response.statusCode == 403) {
                    await this.fHTTPGetToken();
                }
                return false;  //Error
            } 
        }
        return true;  //NO Error
    }
    

    initClient(base_url,apikey) {  //NOT ASYNC 
        this.log.debug("Initializing API Client");
        // Creating a management API client.
        apiclient = new HealthChecksApiClient({
          apiKey: apikey,
          baseUrl: base_url
        });
        
        return apiclient
    }

    async getHealthChecks(client) {
       try {
            const checks = await client.getChecks();
            this.log.info("API Client connected");
            this.setState("info.connection",true,true);
            return checks
       } catch(err) {
            this.log.error("API Client failed: "+err.message);
            this.setState("info.connection",false,true);
            return null
       }
    }
    
    getValues() {
        //Set Timer for next Update
        tmr_GetValues = setTimeout(() =>this.getValues(),this.config.inp_refresh * 60000);
    }

    // eslint-disable-next-line no-unused-vars
    fOverrideExists(sKey) {
        const sType = "";
        const sRole = "";
        //ToDo, check if Override exists, change const to let and overrite it!
        return { name: "", type: sType, role: sRole, read: true, write: false };
    }
    
    fHTTPSendCommand(sCMD, bFirstTry) {
        const oReqBody = {
            "method": "exec",
            "params": [ sCMD ]
        };
        const oReqOpt = {
            "method": "POST",
            "url": this.config.inp_url + "sys?auth="+this.config.sToken,
            "headers": {
                "Content-Type": ["application/json", "text/plain"]
            },
            "body": JSON.stringify(oReqBody)            
        };

        request(oReqOpt, async (error, response, body) => {
            if (await this.fValidateHTTPResult(error,response,"SendCommand, " + sCMD)) {
                try {
                    //bug... output \n\t\ seems broken, delete it
                    body = this.replaceAll(body,"\n\t","");
                    let sBody = JSON.stringify(JSON.parse(body)); 
                    sBody = sBody.replace(/\\t/g,"");
                    sBody = sBody.replace(/\\n/g,"");
                    sBody = sBody.replace(/\\r/g,"");
                    this.setState("sendCommandLastResult",sBody);
                } catch (e) {
                    this.log.error("##### SendCommand, " + sCMD + " + CatchError: " + e);
                    this.setState("sendCommandLastResult","{ \"error\": \"" + e + "\" }");
                }
            } else {
                if (bFirstTry) {
                    this.fHTTPSendCommand(sCMD, false); //If Token was not valid, this ensures it gets renew while fvalidehttpresult
                } else {
                    this.setState("sendCommandLastResult",JSON.stringify(response));
                }
            }
        });
    }


    //##################### DATA FUNCTION

    fSetValue2State(oValue, oKey, sFolder, oTree, channelnames){
        // eslint-disable-next-line prefer-const
        let oCommon = this.fOverrideExists(oKey);
        oCommon.name = oKey;
        
        //this.log.info(oKey + ": " + type.get(oValue));
        if (oCommon.type == "") { //NOT Overwritten
            switch(type.get(oValue)) {
                case "string":
                    oCommon.type = "string"; 
                    oCommon.role =  "string";
                    oCommon.write = false;
                    break;
                case "number":
                    oCommon.type = "number"; 
                    oCommon.role =  "value";
                    oCommon.write = false;
                    break;
                case "boolean":
                    oCommon.type = "boolean"; 
                    oCommon.role =  "inidicator";
                    oCommon.write = false;
                    break;
                case "array":
                    if (Object.entries(oTree[oKey]).length) {  
                        this.setObjectNotExists(sFolder + "." + oKey, {
                            type: "channel",
                            native: {}    
                        });
                        channelnames.remove(this.namespace + "." + sFolder + "." + oKey);
                        this.fSetValue2State(true,"isAvailable",sFolder+"."+oKey,oTree[oKey], channelnames);
                        this.fSetValue2State(this.formatDate(new Date(), "TT.MM.JJJJ hh:mm:ss"),"lastUpdate",sFolder+"."+oKey,oTree[oKey], channelnames);
  
                        for (const [key, value] of Object.entries(oTree[oKey])) {
                            oValue = oValue + ", "+ value;
                            this.fSetValue2State(value,key,sFolder+"."+oKey,oTree[oKey], channelnames);
                        }      
                        oValue.slice(-1);
                    }
                    return; //No need to set this Parent Object
                case "object":
                    if (Object.entries(oTree[oKey]).length) {
                        this.setObjectNotExists(sFolder + "." + oKey, {
                            type: "channel",
                            native: {}    
                        });
                        channelnames.remove(this.namespace + "." + sFolder + "." + oKey);
                        this.fSetValue2State(true,"isAvailable",sFolder+"."+oKey,oTree[oKey], channelnames);
                        this.fSetValue2State(this.formatDate(new Date(), "TT.MM.JJJJ hh:mm:ss"),"lastUpdate",sFolder+"."+oKey,oTree[oKey], channelnames);
                        
                        for (const [key, value] of Object.entries(oTree[oKey])) {
                            oValue = oValue + ", "+ value;
                            this.fSetValue2State(value,key,sFolder+"."+oKey,oTree[oKey], channelnames);
                        }   
                        oValue.slice(-1); 
                    }  
                    return; //No need to set this Parent Object
                default:
                    this.log.warn("Unhandled DataType: " + type.get(oValue) + " for " + oKey);
                    return;  // Do Nothing
            }
        }
        this.setObjectNotExists(sFolder + "." + oCommon.name, {
            type: "state",
            common: oCommon,
            native: {}  
        }, (id, error) => {this.setState(sFolder + "." + oCommon.name, oValue, true);}
        );
    }
    
}



// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Healthchecks(options);
} else {
    // otherwise start the instance directly
    new Healthchecks();
}