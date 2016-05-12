/*
 license: The MIT License, Copyright (c) 2016 YUKI "Piro" Hiroshi
 original:
   http://github.com/piroor/webextensions-lib-configs
*/

function Configs(aDefaults) {
	this.$default = aDefaults;
	this.$lastValues = {};
	this.$loaded = this.$load();
}
Configs.prototype = {
	$reset : function()
	{
		this.$applyValues(this.$default);
		if (this.$shouldUseStorage) {
			return this.$broadcast({
				type : 'Configs:reseted'
			});
		}
		else {
			return new Promise((function(aResolve, aReject) {
				chrome.runtime.sendMessage(
					{
						type : 'Configs:reset'
					},
					function() {
						aResolve();
					}
				);
			}).bind(this));
		}
	},

	$addObserver : function(aObserver)
	{
		var index = this.$observers.indexOf(aObserver);
		if (index < 0)
			this.$observers.push(aObserver);
	},
	$removeObserver : function(aObserver)
	{
		var index = this.$observers.indexOf(aObserver);
		if (index > -1)
			this.$observers.splice(index, 1);
	},
	$observers : [],

	get $shouldUseStorage()
	{
		return typeof chrome.storage !== 'undefined' &&
				location.protocol === 'moz-extension:';
	},

	$log : function(aMessage, ...aArgs)
	{
		var type = this.$shouldUseStorage ? 'storage' : 'bridge' ;
		aMessage = 'Configs[' + type + '] ' + aMessage;
		if (typeof log === 'function')
			log(aMessage, ...aArgs);
		else
			console.log(aMessage, ...aArgs);
	},

	$load : function()
	{
		this.$log('load');
		if (this._promisedLoad) {
			this.$log(' => already loaded');
			return this._promisedLoad;
		}

		this.$applyValues(this.$default);
		chrome.runtime.onMessage.addListener(this.$onMessage.bind(this));

		if (this.$shouldUseStorage) { // background mode
			this.$log('load: try load from storage on  ' + location.href);
			chrome.storage.onChanged.addListener(this.$onChanged.bind(this));
			return this._promisedLoad = new Promise((function(aResolve, aReject) {
				try {
					chrome.storage.local.get(this.$default, (function(aValues) {
						this.$log('load: loaded for ' + location.origin, aValues);
						this.$applyValues(aValues);
						this.$notifyLoaded();
						aResolve(aValues);
					}).bind(this));
				}
				catch(e) {
					this.$log('load: failed', e);
					aReject(e);
				}
			}).bind(this));
		}
		else { // content mode
			this.$log('load: initialize promise on  ' + location.href);
			this._promisedLoad = new Promise((function(aResolve, aReject) {
				this._promisedLoadResolver = aResolve;
			}).bind(this))
				.then((function(aValues) {
					this.$log('load: promise resolved');
					this.$applyValues(aValues);
					return aValues;
				}).bind(this));
			chrome.runtime.sendMessage(
				{
					type : 'Configs:load'
				},
				(function(aValues) {
					if (this._promisedLoadResolver)
						this._promisedLoadResolver(aValues);
					delete this._promisedLoadResolver;
				}).bind(this)
			);
			return this._promisedLoad;
		}
	},
	$applyValues : function(aValues)
	{
		Object.keys(aValues).forEach(function(aKey) {
			this.$lastValues[aKey] = aValues[aKey];
			if (aKey in this)
				return;
			Object.defineProperty(this, aKey, {
				get: (function() {
					return this.$lastValues[aKey];
				}).bind(this),
				set: (function(aValue) {
					this.$log('set: ' + aKey + ' = ' + aValue);
					this.$lastValues[aKey] = aValue;
					this.$notifyUpdated(aKey);
					return aValue;
				}).bind(this)
			});
		}, this);
	},

	$onMessage : function(aMessage, aSender, aResponse)
	{
		this.$log('onMessage: ' + aMessage.type, aSender);
		if (this.$broadcasting) {
			aResponse();
			return;
		}

		switch (aMessage.type)
		{
			// background
			case 'Configs:load':
				this.$load()
					.then((function(aValeus) {
						return this.$notifyLoaded()
								.then(function() {
									aResponse(aValues);
								});
					}).bind(this));
				break;
			case 'Configs:update':
				this[aMessage.key] = aMessage.value;
				aResponse();
				break;
			case 'Configs:reset':
				this.$reset().then(aResponse);
				break;

			// content
			case 'Configs:loaded':
				if (this._promisedLoadResolver)
					this._promisedLoadResolver(aMessage.values);
				delete this._promisedLoadResolver;
				aResponse();
				break;
			case 'Configs:updated':
				this.$lastValues[aMessage.key] = aMessage.value;
				this.$notifyToObservers(aMessage.key);
				aResponse();
				break;
			case 'Configs:reseted':
				this.$applyValues(this.$default);
				Object.keys(this.$default).forEach(function(aKey) {
					this.$notifyToObservers(aKey);
				}, this);
				aResponse();
				break;
		}
	},

	$onChanged : function(aChanges)
	{
		var changedKeys = Object.keys(aChanges);
		changedKeys.forEach(function(aKey) {
			this.$lastValues[aKey] = aChanges[aKey].newValue;
			this.$notifyToObservers(aKey);
		}, this);
	},

	$broadcast : function(aMessage)
	{
		this.$broadcasting = true;

		var promises = [];

		if (chrome.runtime) {
			promises.push(new Promise((function(aResolve, aReject) {
				chrome.runtime.sendMessage(aMessage, (function() {
					aResolve();
				}).bind(this));
			}).bind(this)));
		}

		if (chrome.tabs) {
			promises.push(new Promise((function(aResolve, aReject) {
				chrome.tabs.query({}, (function(aTabs) {
					var promises = aTabs.map(function(aTab) {
						return new Promise((function(aResolve, aReject) {
							chrome.tabs.sendMessage(
								aTab.id,
								aMessage,
								null,
								(function() {
									aResolve();
								}).bind(this)
							);
						}).bind(this));
					}, this);
					Promise.all(promises).then((function() {
						aResolve();
					}).bind(this));
				}).bind(this));
			}).bind(this)));
		}

		return Promise.all(promises).then((function() {
			this.$broadcasting = false;
		}).bind(this));
	},
	$notifyLoaded : function()
	{
		return this.$broadcast({
			type   : 'Configs:loaded',
			values : this.$lastValues
		});
	},
	$notifyUpdated : function(aKey)
	{
		var value = this[aKey];
		if (this.$shouldUseStorage) {
			this.$log('broadcast updated config: ' + aKey + ' = ' + value);
			return this.$broadcast({
				type  : 'Configs:updated',
				key   : aKey,
				value : value
			});
		}
		else {
			this.$log('request to store config: ' + aKey + ' = ' + value);
			return new Promise((function(aResolve, aReject) {
				chrome.runtime.sendMessage(
					{
						type  : 'Configs:update',
						key   : aKey,
						value : value
					},
					function() {
						aResolve();
					}
				);
			}).bind(this));
		}
	},
	$notifyLoaded : function()
	{
		return this.$broadcast({
			type   : 'Configs:loaded',
			values : this.$lastValues
		});
	},
	$notifyToObservers : function(aKey)
	{
		this.$observers.forEach(function(aObserver) {
			if (typeof aObserver === 'function')
				aObserver(aKey);
			else if (aObserver && typeof aObserver.onChangeConfig === 'function')
				aObserver.onChangeConfig(aKey);
		}, this);
	}
};
