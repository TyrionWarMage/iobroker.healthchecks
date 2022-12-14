"use strict";

/*
 * Created with @iobroker/create-adapter v1.23.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const type = require("get-type");
const schedule = require('node-schedule');
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
        
        super({
            ...options,
            name: "healthchecks",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("objectChange", this.onObjectChange.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
        
        this.updateTrigger = null;   

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

    createInitialSetup() {
        this.setObjectNotExists("info.connection", {
                type: "state",
                common: { name: "Device or service connected", type: "boolean", role: "indicator.connected", read: true, write: false },
                native: {}  
            }, (id, error) => {this.log.debug("Added info");}
        );
        this.setState("info.connection", false, true);

        this.setObjectNotExists("deleteCheck", {
                type: "state",
                common: { name: "Delete a check by uuid", type: "string", role: "text", read: false, write: true },
                native: {}  
            }, (id, error) => {this.log.debug("Added delete command");}
        );
        this.setObjectNotExists("createCheck", {
                type: "state",
                common: { name: "Create a check", type: "string", role: "json", read: false, write: true },
                native: {}  
            }, (id, error) => {this.log.debug("Added create command");}
        ); 
        
        this.setObjectNotExists("pingSuccess", {
                type: "state",
                common: { name: "Ping uuid with success message", type: "string", role: "text", read: false, write: true },
                native: {}  
            }, (id, error) => {this.log.debug("Added pingSuccess command");}
        );
        this.setObjectNotExists("pingFail", {
                type: "state",
                common: { name: "Ping uuid with failed message", type: "string", role: "text", read: false, write: true },
                native: {}  
            }, (id, error) => {this.log.debug("Added pingFailed command");}
        ); 
        
        this.schedules = {};      
    }   
     
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        let preCheckFailure = false;   //We can't stop the adapter since we need it 4 url and auth check. Make preCheck, if error found don't run main functions 
        
        this.createInitialSetup();
                
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
            const checks = await this.tryChecks(this.client);
            if (checks === true) {
                this.setState("info.connection",true,true);
                this.getDevices((err,result) => {
                    const device_names = result.map(device => device.common.name)
                    if (!(device_names.includes("checks"))) {
                        this.createDevice("checks", (err,result) => {
                            this.updateAndSchedule();
                        });    
                    } else {
                        this.updateAndSchedule();    
                    }   
                });     
            } else {
                this.setState("info.connection",false,true);
            }
        } else {
            this.log.error("Initialization failed.");
        }
                       
        this.subscribeStates("*");
        this.subscribeForeignObjects('*');
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            schedule.gracefulShutdown();
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

    async getUUIDbyDesc(channels,desc) {
        for (const check of channels) {
            const stateid = await this.getStateAsync(check._id + ".desc");
            if (desc == stateid.val) {
                const uuid = check._id.split(".");
                return uuid[uuid.length - 1];
            }   
        }
        return null;    
    }
    
    async onObjectChange(id, obj) {
        if (obj && obj.common && obj.from != 'system.adapter.' + this.namespace) {
            const channels = await this.getChannelsOfAsync("checks");
            const identifier = await this.getUUIDbyDesc(channels, id);
            if (obj.common.custom && obj.common.custom[this.namespace] && typeof obj.common.custom[this.namespace] === 'object' && obj.common.custom[this.namespace].enabled) {
                this.log.debug("Enabled for "+id);  
                let params = JSON.parse(JSON.stringify(obj.common.custom[this.namespace]));
                params.desc = id;
                delete params["enabled"];
                if (!params.tags) {
                    params.tags = "";
                } else {
                    params.tags = params.tags + " ";   
                }
                params.grace = params.grace * 60;
                params.timeout = params.timeout * 60;
                params.tags = params.tags + "iobroker "+id.split(".")[0]
                if (params.invert) {
                    params.tags = params.tags + " invert";
                }
                delete params["invert"];
                if (identifier) {
                    this.updateCheckByUUID(identifier,params);
                } else {
                    this.createCheck(params);
                }  
            } else {     
                if (identifier) {
                    this.log.debug("Disabled for "+identifier); 
                    this.deleteCheckByUUID(identifier);    
                }
            }
        }
    }
    
    deleteCheckByUUID(uuid) {
        this.client.deleteCheck(uuid)
            .then(result => {   
                                this.log.info("Delete check succeeded for "+uuid);
                                this.updateChecks();
                            })
            .catch(err => {this.log.error("Delete check failed: "+err)});           
    }
    
    createCheck(params) {
        this.client.createCheck(params)
            .then(result => {
                                this.log.info("Create check succeeded.");
                                this.updateChecks();
                            })
            .catch(err => {this.log.error("Create check failed: "+err)});        
    }
    
    async updateCheckByUUID(uuid,params) {
        this.client.updateCheck(uuid,params)
            .then(result => {
                                this.log.info("Update check succeeded.");
                                this.updateChecks();
                            })
            .catch(err => {this.log.error("Check updated failed: "+err)});            
    }

    conditionalPing(uuid,state,invert) {
        this.log.debug("Trying conditional ping for "+state);
        this.getForeignStateAsync(state)
            .then(val => {
                if (val.val) {
                    this.ping(uuid,!invert);
                } else {
                    this.ping(uuid,invert);
                }             
            }).catch(err => {
                this.log.error(err);    
            });   
    }
    
    ping(uuid,success) {
        const pingClient = new HealthChecksPingClient({baseUrl: this.config.inp_url_ping, uuid: uuid});
        if (success) {
            pingClient.success()
                .then(result => { this.log.info("Pinged fail for "+uuid) })
                .catch(err => {this.log.error("Ping fail failed: "+err)});            
        } else {
            pingClient.fail()
                .then(result => { this.log.info("Pinged success for "+uuid) })
                .catch(err => {this.log.error("Ping success failed: "+err)});      
        }     
    }    
    
    onStateChange(id, state) {
        if (state) {
            if (state.from != 'system.adapter.' + this.namespace) {
                if (id === this.namespace + ".deleteCheck") {
                    this.deleteCheckByUUID(state.val);
                } else if (id === this.namespace + ".createCheck") {
                    const check = JSON.parse(state.val)
                    this.createCheck(check);
                } else if (id === this.namespace + ".pingSuccess") {
                    this.ping(state.val,true);
                } else if (id === this.namespace + ".pingFail") {
                    this.ping(state.val,false);             
                } else {
                    let params = {};
                    const key = id.split(".").pop();
                    params[key] = state.val;
                    let fullname = id.split(".");
                    this.getState(fullname.slice(0,fullname.length - 1).join(".") + ".uuid", (err,uuid) => {
                        this.updateCheckByUUID(uuid.val,params);   
                    });
                }         
            }
        } else {
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
            const checks = await this.tryChecks(client);
            if (checks === true) {
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

    async tryChecks(client) {
       try {
            await client.getChecks();
            this.log.info("API Client connected");
            return true;
       } catch(err) {
            this.log.error("API Client failed: "+err.message);
            return false;
       }
    }

    updateAndSchedule() {       
        this.updateTrigger = setTimeout(() =>this.updateAndSchedule(),this.config.inp_refresh * 60000); 
        this.updateChecks()  
    }   

    schedulePing(check) {
        const schedule_pattern = "*/"+(check.timeout/60)+" * * * *";
        if (check.uuid in this.schedules) {
            this.schedules[check.uuid].cancel();
            this.log.debug("Canceled "+check.uuid);               
        }
        const adapter = this;
        const job = schedule.scheduleJob(schedule_pattern, function() {
            adapter.conditionalPing(check.uuid,check.desc,check.tags.includes("invert"));
        });
        this.log.debug("Added scheduler for "+check.uuid+" with pattern "+schedule_pattern);
        this.schedules[check.uuid] = job;    
    }   
      
    updateChecks() {
        this.log.debug("Updating checks");
        
        this.client.getChecks().then(checks => {
            this.getChannelsOf("checks",(err,channels) => {
                let old_checks = channels.map(channel => {
                    const uuid = channel._id.split("."); 
                    return uuid[uuid.length - 1];   
                });
    
                for (const check of checks.checks) {
                    const uuid = check.ping_url.split("/").pop();
                    check.uuid = uuid;
                    const identifier = check.uuid;
                    
                    if (!old_checks.includes(identifier)) {
                        this.setObjectNotExists("checks."+identifier, {
                                type: "channel",
                                common: {name: check.name},
                                native: {}  
                            });
                        if (check.tags && check.tags.includes("iobroker")) {
                            this.schedulePing(check);
                        }
                        this.log.debug("Created channel "+identifier)
                    } else {
                        if (check.tags && check.tags.includes("iobroker")) {
                            const scheduler = this.schedules;
                            if (!(check.uuid in scheduler)) {
                                this.schedulePing(check);    
                            } else {
                                this.getState("checks."+identifier+".timeout", (err, val) => {
                                    if (val.val != check.timeout) {
                                        this.schedulePing(check);    
                                    } else {
                                        this.getState("checks."+identifier+".tags", (err, val) => {
                                            if (val.val != check.tags) {
                                                this.schedulePing(check);    
                                            }  
                                        });                                         
                                    }   
                                });       
                            }               
                        }
                        old_checks.remove(identifier);
                    }
                    
                    if(!('tz' in check)) {
                        check['tz'] = null;
                    }

                    for (const [subkey, subvalue] of Object.entries(check)) {
                        this.updateStates(subkey, subvalue, "checks."+identifier);
                    }
                }   
                
                for (const check_name of old_checks) {
                    if (check_name in this.schedules) {
                        this.schedules[check_name].cancel();
                        delete this.schedules[check_name];
                    }
                    this.deleteChannel("checks",check_name); 
                }
            
            })}).catch(err => {
                this.log.error("Could not get checks: "+err);    
            });
        
    }

    updateStates(key, value, root) {
    
        const writeable = ["name","tags","desc","timeout","grace","schedule","tz","manual_resume","methods","channels","success_kw","failure_kw","filter_subject","filter_body"];
        let state_obj = { name: key, type: "", role: "", read: true, write: false };    
        if (writeable.includes(key)) {
            state_obj.write = true;    
        }
        
        switch(type.get(value)) {
            case "string":
                const time = Date.parse(value);
                if (isNaN(time)) {
                    state_obj.type = "string"; 
                    if (key.includes("url")) {
                        state_obj.role =  "url";
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
                if (key == 'tz') {
                    state_obj.type = "string";  
                    state_obj.role =  "text"; 
                }
                break;
            default:
                this.log.warn("Unhandled DataType: " + type.get(value) + " for " + key);
                return;
        }
        this.setObjectNotExists(root + "." + key, {
                type: "state",
                common: state_obj,
                native: {}  
            }, (err, id) => {
                this.setState(root + "." + key, value, true, (err) => {
                    if(err) {
                        this.log.debug(err);   
                    }
                });
            }
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
