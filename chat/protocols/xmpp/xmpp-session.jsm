/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

this.EXPORTED_SYMBOLS = ["XMPPSession", "XMPPDefaultResource"];

var {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("resource:///modules/socket.jsm");
Cu.import("resource:///modules/xmpp-xml.jsm");
Cu.import("resource:///modules/xmpp-authmechs.jsm");

XPCOMUtils.defineLazyGetter(this, "_", () =>
  l10nHelper("chrome://chat/locale/xmpp.properties")
);

// Workaround because a lazy getter can't be exported.
XPCOMUtils.defineLazyGetter(this, "_defaultResource", () =>
  l10nHelper("chrome://branding/locale/brand.properties")("brandShortName")
);
__defineGetter__("XMPPDefaultResource", () => _defaultResource);

function XMPPSession(aHost, aPort, aSecurity, aJID, aPassword, aAccount) {
  this._host = aHost;
  this._port = aPort;

  this._connectionSecurity = aSecurity;
  if (this._connectionSecurity == "old_ssl")
    this._security = ["ssl"];
  else if (this._connectionSecurity != "none")
    this._security = [(aPort == 5223 || aPort == 443) ? "ssl" : "starttls"];

  if (!aJID.node) {
    aAccount.reportDisconnecting(Ci.prplIAccount.ERROR_INVALID_USERNAME,
                                 _("connection.error.invalidUsername"));
    aAccount.reportDisconnected();
    return;
  }
  this._jid = aJID;
  this._domain = aJID.domain;
  this._password = aPassword;
  this._account = aAccount;

  this._resource = aJID.resource || XMPPDefaultResource;
  this._handlers = new Map();

  this._account.reportConnecting();
  try {
    this.connect(this._host, this._port, this._security);
  } catch (e) {
    Cu.reportError(e);
    // We can't use _networkError because this._account._connection
    // isn't set until we return from the XMPPSession constructor.
    this._account.reportDisconnecting(Ci.prplIAccount.ERROR_NETWORK_ERROR,
                                      _("connection.error.failedToCreateASocket"));
    this._account.reportDisconnected();
  }
}

XMPPSession.prototype = {
  /* for the socket.jsm helper */
  __proto__: Socket,
  connectTimeout: 60,
  readWriteTimeout: 300,
  sendPing: function() {
    this.sendStanza(Stanza.iq("get", null, null,
                              Stanza.node("ping", Stanza.NS.ping)),
                    this.cancelDisconnectTimer, this);
  },
  _lastReceiveTime: 0,
  _lastSendTime: 0,
  checkPingTimer(aJustSentSomething = false) {
    // Don't start a ping timer if we're not fully connected yet.
    if (this.onXmppStanza != this.stanzaListeners.accountListening)
      return;
    let now = Date.now();
    if (aJustSentSomething)
      this._lastSendTime = now;
    else
      this._lastReceiveTime = now;
    // We only cancel the ping timer if we've both received and sent
    // something in the last two minutes. This is because Openfire
    // servers will disconnect us if we don't send anything for a
    // couple of minutes.
    if (Math.min(this._lastSendTime, this._lastReceiveTime) >
        now - this.kTimeBeforePing)
      this.resetPingTimer();
  },

  get DEBUG() { return this._account.DEBUG; },
  get LOG() { return this._account.LOG; },
  get WARN() { return this._account.WARN; },
  get ERROR() { return this._account.ERROR; },

  _security: null,
  _encrypted: false,

  /* Disconnect from the server */
  disconnect: function() {
    if (this.onXmppStanza == this.stanzaListeners.accountListening)
      this.send("</stream:stream>");
    delete this.onXmppStanza;
    Socket.disconnect.call(this);
    if (this._parser) {
      this._parser.destroy();
      delete this._parser;
    }
    this.cancelDisconnectTimer();
  },

  /* Report errors to the account */
  onError: function(aError, aException) {
    this._account.onError(aError, aException);
  },

  /* Send a text message to the server */
  send: function(aMsg, aLogString) {
    this.sendString(aMsg, "UTF-8", aLogString);
  },

  /* Send a stanza to the server.
   * Can set a callback if required, which will be called when the server
   * responds to the stanza with a stanza of the same id. The callback should
   * return true if the stanza was handled, false if not. Note that an
   * undefined return value is treated as true.
   */
  sendStanza: function(aStanza, aCallback, aThis, aLogString) {
    if (!aStanza.attributes.hasOwnProperty("id"))
      aStanza.attributes["id"] = this._account.generateId();
    if (aCallback)
      this._handlers.set(aStanza.attributes.id, aCallback.bind(aThis));
    this.send(aStanza.getXML(), aLogString);
    this.checkPingTimer(true);
    return aStanza.attributes.id;
  },

  /* This method handles callbacks for specific ids. */
  execHandler: function(aId, aStanza) {
    let handler = this._handlers.get(aId);
    if (!handler)
      return false;
    let isHandled = handler(aStanza);
    // Treat undefined return values as handled.
    if (isHandled === undefined)
      isHandled = true;
    this._handlers.delete(aId);
    return isHandled;
  },

  /* Start the XMPP stream */
  startStream: function() {
    if (this._parser)
      this._parser.destroy();
    this._parser = new XMPPParser(this);
    this.send('<?xml version="1.0"?><stream:stream to="' + this._domain +
              '" xmlns="jabber:client" xmlns:stream="http://etherx.jabber.org/streams" version="1.0">');
  },

  startSession: function() {
    this.sendStanza(Stanza.iq("set", null, null,
                              Stanza.node("session", Stanza.NS.session)),
                    (aStanza) => aStanza.attributes["type"] == "result");
    this.onXmppStanza = this.stanzaListeners.sessionStarted;
  },

  /* XEP-0078: Non-SASL Authentication */
  startLegacyAuth: function() {
    if (!this._encrypted && this._connectionSecurity == "require_tls") {
      this.onError(Ci.prplIAccount.ERROR_ENCRYPTION_ERROR,
                   _("connection.error.startTLSNotSupported"));
      return;
    }

    this.onXmppStanza = this.stanzaListeners.legacyAuth;
    let s = Stanza.iq("get", null, this._domain,
                      Stanza.node("query", Stanza.NS.auth, null,
                                  Stanza.node("username", null, null,
                                              this._jid.node)));
    this.sendStanza(s);
  },

  /* Socket events */
  /* The connection is established */
  onConnection: function() {
    if (this._security.indexOf("ssl") != -1) {
      this.onXmppStanza = this.stanzaListeners.startAuth;
      this._encrypted = true;
    }
    else
      this.onXmppStanza = this.stanzaListeners.initStream;
    this._account.reportConnecting(_("connection.initializingStream"));
    this.startStream();
  },

  /* When incoming data is available to be parsed */
  onDataReceived: function(aData) {
    this.checkPingTimer();
    let istream = Cc["@mozilla.org/io/string-input-stream;1"]
                    .createInstance(Ci.nsIStringInputStream);
    istream.setData(aData, aData.length);
    this._lastReceivedData = aData;
    try {
      this._parser.onDataAvailable(istream, 0, aData.length);
    } catch(e) {
      Cu.reportError(e);
      this.onXMLError("parser-exception", e);
    }
    delete this._lastReceivedData;
  },

  /* The connection got disconnected without us closing it. */
  onConnectionClosed: function() {
    this._networkError(_("connection.error.serverClosedConnection"));
  },
  onBadCertificate: function(aIsSslError, aNSSErrorMessage) {
    let error = this._account.handleBadCertificate(this, aIsSslError);
    this.onError(error, aNSSErrorMessage);
  },
  onConnectionReset: function() {
    this._networkError(_("connection.error.resetByPeer"));
  },
  onConnectionTimedOut: function() {
    this._networkError(_("connection.error.timedOut"));
  },
  _networkError: function(aMessage) {
    this.onError(Ci.prplIAccount.ERROR_NETWORK_ERROR, aMessage);
  },


  /* Methods called by the XMPPParser instance */
  onXMLError: function(aError, aException) {
    if (aError == "parsing-characters")
      this.WARN(aError + ": " + aException + "\n" + this._lastReceivedData);
    else
      this.ERROR(aError + ": " + aException + "\n" + this._lastReceivedData);
    if (aError != "parse-warning" && aError != "parsing-characters")
      this._networkError(_("connection.error.receivedUnexpectedData"));
  },

  // All the functions in stanzaListeners are used as onXmppStanza
  // implementations at various steps of establishing the session.
  stanzaListeners: {
    initStream: function(aStanza) {
      if (aStanza.localName != "features") {
        this.ERROR("Unexpected stanza " + aStanza.localName + ", expected 'features'");
        this._networkError(_("connection.error.incorrectResponse"));
        return;
      }

      let starttls = aStanza.getElement(["starttls"]);
      if (starttls && this._security.indexOf("starttls") != -1) {
        this._account.reportConnecting(_("connection.initializingEncryption"));
        this.sendStanza(Stanza.node("starttls", Stanza.NS.tls));
        this.onXmppStanza = this.stanzaListeners.startTLS;
        return;
      }
      if (starttls &&
          starttls.children.some(c => c.localName == "required")) {
        this.onError(Ci.prplIAccount.ERROR_ENCRYPTION_ERROR,
                     _("connection.error.startTLSRequired"));
        return;
      }
      if (!starttls && this._connectionSecurity == "require_tls") {
        this.onError(Ci.prplIAccount.ERROR_ENCRYPTION_ERROR,
                     _("connection.error.startTLSNotSupported"));
        return;
      }

      // If we aren't starting TLS, jump to the auth step.
      this.onXmppStanza = this.stanzaListeners.startAuth;
      this.onXmppStanza(aStanza);
    },
    startTLS: function(aStanza) {
      if (aStanza.localName != "proceed") {
        this._networkError(_("connection.error.failedToStartTLS"));
        return;
      }

      this.startTLS();
      this._encrypted = true;
      this.startStream();
      this.onXmppStanza = this.stanzaListeners.startAuth;
    },
    startAuth: function(aStanza) {
      if (aStanza.localName != "features") {
        this.ERROR("Unexpected stanza " + aStanza.localName + ", expected 'features'");
        this._networkError(_("connection.error.incorrectResponse"));
        return;
      }

      let mechs = aStanza.getElement(["mechanisms"]);
      if (!mechs) {
        let auth = aStanza.getElement(["auth"]);
        if (auth && auth.uri == Stanza.NS.auth_feature)
          this.startLegacyAuth();
        else
          this._networkError(_("connection.error.noAuthMec"));
        return;
      }

      // Select the auth mechanism we will use. PLAIN will be treated
      // a bit differently as we want to avoid it over an unencrypted
      // connection, except if the user has explicly allowed that
      // behavior.
      let authMechanisms = this._account.authMechanisms || XMPPAuthMechanisms;
      let selectedMech = "";
      let canUsePlain = false;
      mechs = mechs.getChildren("mechanism");
      for each (let m in mechs) {
        let mech = m.innerText;
        if (mech == "PLAIN" && !this._encrypted) {
          // If PLAIN is proposed over an unencrypted connection,
          // remember that it's a possibility but don't bother
          // checking if the user allowed it until we have verified
          // that nothing more secure is available.
          canUsePlain = true;
        }
        else if (authMechanisms.hasOwnProperty(mech)) {
          selectedMech = mech;
          break;
        }
      }
      if (!selectedMech && canUsePlain) {
        if (this._connectionSecurity == "allow_unencrypted_plain_auth")
          selectedMech = "PLAIN";
        else {
          this.onError(Ci.prplIAccount.ERROR_AUTHENTICATION_IMPOSSIBLE,
                       _("connection.error.notSendingPasswordInClear"));
          return;
        }
      }
      if (!selectedMech) {
        this.onError(Ci.prplIAccount.ERROR_AUTHENTICATION_IMPOSSIBLE,
                     _("connection.error.noCompatibleAuthMec"));
        return;
      }
      let authMec = new authMechanisms[selectedMech](this._jid.node,
                                                     this._password,
                                                     this._domain);
      this._password = null;

      this._account.reportConnecting(_("connection.authenticating"));
      this.onXmppStanza = this.stanzaListeners.authDialog.bind(this, authMec);
      this.onXmppStanza(null); // the first auth step doesn't read anything
    },
    authDialog: function(aAuthMec, aStanza) {
      if (aStanza && aStanza.localName == "failure") {
        let errorMsg = "authenticationFailure";
        if (aStanza.getElement(["not-authorized"]))
          errorMsg = "notAuthorized";
        this.onError(Ci.prplIAccount.ERROR_AUTHENTICATION_FAILED,
                     _("connection.error." + errorMsg));
        return;
      }

      // OpenFire sometimes sends us a success stanza before the end
      // of the DIGEST-MD5 exchange... See bug 787046.
      if (aStanza && aStanza.localName == "success") {
        this.stanzaListeners.authResult.call(this, aStanza);
        return;
      }

      let result;
      try {
        result = aAuthMec.next(aStanza);
      } catch(e) {
        this.ERROR(e);
        this.onError(Ci.prplIAccount.ERROR_AUTHENTICATION_FAILED,
                     _("connection.error.authenticationFailure"));
        return;
      }

      if (result.send)
        this.send(result.send.getXML(), result.log);
      if (result.done)
        this.onXmppStanza = this.stanzaListeners.authResult;
    },
    authResult: function(aStanza) {
      if (aStanza.localName != "success") {
        this.onError(Ci.prplIAccount.ERROR_AUTHENTICATION_FAILED,
                     _("connection.error.notAuthorized"));
        return;
      }

      this.startStream();
      this.onXmppStanza = this.stanzaListeners.startBind;
    },
    startBind: function(aStanza) {
      if (!aStanza.getElement(["bind"])) {
        this.ERROR("Unexpected lack of the bind feature");
        this._networkError(_("connection.error.incorrectResponse"));
        return;
      }

      this._account.reportConnecting(_("connection.gettingResource"));
      this.sendStanza(Stanza.iq("set", null, null,
                                Stanza.node("bind", Stanza.NS.bind, null,
                                            Stanza.node("resource", null, null,
                                                        this._resource))));
      this.onXmppStanza = this.stanzaListeners.bindResult;
    },
    bindResult: function(aStanza) {
      let jid = aStanza.getElement(["bind", "jid"]);
      if (!jid) {
        this._networkError(_("connection.error.failedToGetAResource"));
        return;
      }
      jid = jid.innerText;
      this.DEBUG("jid = " + jid);
      this._jid = this._account._parseJID(jid);
      this.startSession();
    },
    legacyAuth: function(aStanza) {
      if (aStanza.attributes["type"] == "error") {
        let error = aStanza.getElement(["error"]);
        if (!error) {
          this._networkError(_("connection.error.incorrectResponse"));
          return;
        }

        let code = parseInt(error.attributes["code"], 10);
        if (code == 401) {
          // Failed Authentication (Incorrect Credentials)
          this.onError(Ci.prplIAccount.ERROR_AUTHENTICATION_FAILED,
                       _("connection.error.notAuthorized"));
          return;
        }
        else if (code == 406) {
          // Failed Authentication (Required Information Not Provided)
          this.onError(Ci.prplIAccount.ERROR_AUTHENTICATION_FAILED,
                       _("connection.error.authenticationFailure"));
          return;
        }
        // else if (code == 409) {
          // Failed Authentication (Resource Conflict)
          // XXX Flo The spec in XEP-0078 defines this error code, but
          // I've yet to find a server sending it. The server I tested
          // with just closed the first connection when a second
          // connection was attempted with the same resource.
          // libpurple's jabber prpl doesn't support this code either.
        // }
      }

      if (aStanza.attributes["type"] != "result") {
        this._networkError(_("connection.error.incorrectResponse"));
        return;
      }

      if (aStanza.children.length == 0) {
        // Success!
        this._password = null;
        this.startSession();
        return;
      }

      let query = aStanza.getElement(["query"]);
      let values = {};
      for each (let c in query.children)
        values[c.qName] = c.innerText;

      if (!("username" in values) || !("resource" in values)) {
        this._networkError(_("connection.error.incorrectResponse"));
        return;
      }

      let children = [
        Stanza.node("username", null, null, this._jid.node),
        Stanza.node("resource", null, null, this._resource)
      ];

      let logString;
      if (("digest" in values) && this._streamId) {
        let hashBase = this._streamId + this._password;

        let ch =
          Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
        ch.init(ch.SHA1);
        // Non-US-ASCII characters MUST be encoded as UTF-8 since the
        // SHA-1 hashing algorithm operates on byte arrays.
        let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                          .createInstance(Ci.nsIScriptableUnicodeConverter);
        converter.charset = "UTF-8";
        let data = converter.convertToByteArray(hashBase);
        ch.update(data, data.length);
        let hash = ch.finish(false);
        let toHexString =
          charCode => ("0" + charCode.toString(16)).slice(-2);
        let digest = [toHexString(hash.charCodeAt(i)) for (i in hash)].join("");

        children.push(Stanza.node("digest", null, null, digest));
        logString =
          "legacyAuth stanza containing SHA-1 hash of the password not logged";
      }
      else if ("password" in values) {
        if (!this._encrypted &&
            this._connectionSecurity != "allow_unencrypted_plain_auth") {
          this.onError(Ci.prplIAccount.ERROR_AUTHENTICATION_IMPOSSIBLE,
                       _("connection.error.notSendingPasswordInClear"));
          return;
        }
        children.push(Stanza.node("password", null, null, this._password));
        logString = "legacyAuth stanza containing password not logged";
      }
      else {
        this.onError(Ci.prplIAccount.ERROR_AUTHENTICATION_IMPOSSIBLE,
                     _("connection.error.noCompatibleAuthMec"));
        return;
      }

      let s = Stanza.iq("set", null, this._domain,
                        Stanza.node("query", Stanza.NS.auth, null, children));
      this.sendStanza(s, undefined, undefined,
        '<iq type="set".../> (' + logString + ')');
    },
    sessionStarted: function(aStanza) {
      this.resetPingTimer();
      this._account.onConnection();
      this.LOG("Account successfully connected.");
      this.onXmppStanza = this.stanzaListeners.accountListening;
    },
    accountListening: function(aStanza) {
      let id = aStanza.attributes.id;
      if (id && this.execHandler(id, aStanza))
        return;

      this._account.onXmppStanza(aStanza);
      let name = aStanza.qName;
      if (name == "presence")
        this._account.onPresenceStanza(aStanza);
      else if (name == "message")
        this._account.onMessageStanza(aStanza);
      else if (name == "iq")
        this._account.onIQStanza(aStanza);
    }
  },
  onXmppStanza: function(aStanza) {
    this.ERROR("should not be reached\n");
  }
};
