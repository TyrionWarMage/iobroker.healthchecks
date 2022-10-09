"use strict";

/*
 * Created with @iobroker/create-adapter v1.23.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const type = require("get-type");
const {
  HealthChecksPingClient,
  HealthChecksApiClient
} = require('healthchecks-io-client');

Array.prototype.remove = function() {
    var what, a = arguments, L = a.length, ax;
    while (L && this.length) {
        what = a[--L];
        while ((ax = this.indexOf(what)) !== -1) {
            this.splice(ax, 1);
        }
    }
    return this;
};

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
        
        this.updateTrigger = null;
        this.createDevice("checks")
    }

    decrypt(key, value) {
        let result = "";
        for (let i = 0; i < value.length; ++i) {
            result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
        }
        this.log.debug("API key decrypted");
        return result;
    }

    replaceAll(str, find, replace) {
        return str.replace(new RegExp(find, "g"), replace);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        let preCheckFailure = false;   //We can't stop the adapter since we need it 4 url and auth check. Make preCheck, if error found don't run main functions 

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
            preCheckFailure = true;  //Dont run
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

        if (!preCheckFailure) {
            this.client = this.initClient(this.config.inp_url,this.apikey);
            const checks = await this.getHealthChecks(this.client);
            if (checks !== null) {
                this.updateChecks();    
            }
        } else {
            this.log.error("Initialization failed.");
        }
                       
        this.subscribeStates("*");
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            if (this.updateTrigger) {
                clearInterval(this.updateTrigger);
                this.updateTrigger = null;
            }
            this.log.info("cleaned everything up...");
            callback();
        } catch (e) {
            callback();
        }
    }

    onStateChange(id, state) {
        if (state) {

        } else {
            // The state was deleted
            this.log.debug(`state ${id} deleted`);
        }
    }

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
    
    initClient(base_url,apikey) {  //NOT ASYNC 
        this.log.debug("Initializing API Client");
        // Creating a management API client.
        const apiclient = new HealthChecksApiClient({
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
    
    async updateChecks() {
        //Set Timer for next Update
        this.updateTrigger = setTimeout(() =>this.updateChecks(),this.config.inp_refresh * 60000);
        const checks = await this.getHealthChecks(this.client)
        
        this.getChannelsOf("checks",(err,channels) => {
            let old_checks = Object.assign({}, ...channels.map((channel) => ({[channel.common.name]: channel._id})));

            for (const check of checks.checks) {
                if (!check.name in old_checks) {
                    this.createChannel("checks",check.name);  
                    this.log.debug("Created channel "+check.name)
                } else {
                    delete old_checks[check.name];
                }
                for (const [subkey, subvalue] of Object.entries(check)) {
                    this.updateStates(subkey, subvalue, "checks."+check.name);
                }
            }   
            
            for (const [check_name,id] of Object.entries(old_checks)) {
                this.deleteChannel("checks",check_name); 
            }
        
        });
        
    }

    updateStates(key, value, root) {
    
        let state_obj = { name: key, type: "", role: "", read: true, write: true };    
        switch(type.get(value)) {
            case "string":
                const time = Date.parse(value);
                if (isNaN(time)) {
                    state_obj.type = "string"; 
                    if (key.includes("url")) {
                        state_obj.role =  "text.url";
                    } else {
                        state_obj.role =  "text";       
                    }                       
                } else {
                    state_obj.type = "number"; 
                    state_obj.role =  "value.time";  
                    value = time;                              
                }
                break;
            case "number":
                state_obj.type = "number"; 
                state_obj.role =  "value";
                break;
            case "boolean":
                state_obj.type = "boolean"; 
                state_obj.role =  "inidicator";
                break;
            case "null":
                if (key.includes("last_ping") || key.includes("next_ping")) {
                    state_obj.type = "number"; 
                    state_obj.role =  "value.time";                      
                }
                break;
            default:
                this.log.warn("Unhandled DataType: " + type.get(value) + " for " + key);
                return;  // Do Nothing
        }

        this.setObjectNotExists(root + "." + key, {
                type: "state",
                common: state_obj,
                native: {}  
            }, (id, error) => {this.setState(root + "." + key, value, true);}
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
