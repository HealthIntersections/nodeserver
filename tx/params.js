const {Languages, LanguageDefinitions} = require("../library/languages");
const { validateResource, strToBool, getValuePrimitive, validateParameter, Utilities} = require("../library/utilities");
const {Issue} = require("./library/operation-outcome");
const {I18nSupport} = require("../library/i18nsupport");

class VersionRule {
  system;
  version;
  mode;

  constructor(system, version, vs, mode = null) {
    this.system = system;
    this.version = version;
    this.vs = vs;
    this.mode = mode;
  }
  asString() {
    return this.mode + ':' + this.system + '#' + this.version;
  }

  asParam() {
    switch (this.mode) {
      case 'default': return (this.vs ? "default-valueset-version": "system-version") + '=' + this.system + '|' + this.version;
      case 'override': return (this.vs ? "force-valueset-version": "force-system-version") + '=' + this.system + '|' + this.version;
      case 'check': return (this.vs ? "check-valueset-version": "check-system-version") + '=' + this.system + '|' + this.version;
      default: throw new Error("Unsupported mode '" + this.mode + "'");
    }
  }

}

class TxParameters {
  count = -1;
  limit = -1;
  offset = -1;
  validating = false;
  abstractOk = true; // note true!
  inferSystem = false;

  constructor(languages, i18n, validating) {
    validateParameter(languages, 'languages', LanguageDefinitions);
    validateParameter(i18n, 'i18n', I18nSupport);

    this.languageDefinitions = languages;
    this.i18n = i18n;
    this.validating = validating;
    this.FVersionRules = [];
    this.FProperties = [];
    this.FDesignations = [];
    this.supplements = new Set;
    this.FGenerateNarrative = true;

    this.FHTTPLanguages = null;
    this.FDisplayLanguages = null;
    this.FValueSetVersionRules = null;
    this.FUid = '';

    this.FActiveOnly = false;
    this.FExcludeNested = false;
    this.FExcludeNotForUI = false;
    this.FExcludePostCoordinated = false;
    this.FIncludeDesignations = false;
    this.FIncludeDefinition = false;
    this.FDefaultToLatestVersion = false;
    this.FDisplayWarning = false;
    this.FMembershipOnly = false;
    this.FDiagnostics = false;

    this.hasActiveOnly = false;
    this.hasExcludeNested = false;
    this.hasGenerateNarrative = false;
    this.hasExcludeNotForUI = false;
    this.hasExcludePostCoordinated = false;
    this.hasIncludeDesignations = false;
    this.hasIncludeDefinition = false;
    this.hasDefaultToLatestVersion = false;
    this.hasDisplayWarning = false;
    this.hasMembershipOnly = false;
  }

  readParams(params) {
    validateResource(params, "params", "Parameters");

    if (!params.parameter) {
      return;
    }
    if (!this.hasHTTPLanguages && this.hasParam(params, "__Content-Language")) {
      this.HTTPLanguages = Languages.fromAcceptLanguage(this.paramstr(params, "__Content-Language"), this.languageDefinitions, !this.validating);
    }
    if (!this.hasHTTPLanguages && this.hasParam(params, "__Accept-Language")) {
      this.HTTPLanguages = Languages.fromAcceptLanguage(this.paramstr(params, "__Accept-Language"), this.languageDefinitions, !this.validating);
    }

    for (let p of params.parameter) {
      switch (p.name) {
        // Version rules
        case 'system-version': {
          this.seeVersionRule(getValuePrimitive(p), false,'default');
          break;
        }
        case 'check-system-version': {
          this.seeVersionRule(getValuePrimitive(p), false, 'check');
          break;
        }
        case 'force-system-version': {
          this.seeVersionRule(getValuePrimitive(p), false, 'override');
          break;
        }
        case 'default-valueset-version': {
          this.seeVersionRule(getValuePrimitive(p), true, 'default');
          break;
        }
        case 'force-valueset-version': {
          this.seeVersionRule().push(getValuePrimitive(p), true, 'override');
          break;
        }
        case 'check-valueset-version': {
          this.seeVersionRule().push(getValuePrimitive(p), true, 'check');
          break;
        }

        case 'displayLanguage': {
          try {
            this.DisplayLanguages = Languages.fromAcceptLanguage(getValuePrimitive(p), this.languageDefinitions, !this.validating);
          } catch (error) {
            throw new Issue("error", "processing", null, 'INVALID_DISPLAY_NAME', this.i18n.translate('INVALID_DISPLAY_NAME', this.HTTPLanguages, [getValuePrimitive(p)])).handleAsOO(400);
          }
          break;
        }
        case 'designation': {
          this.designations.push(getValuePrimitive(p));
          break;
        }
        case 'property': {
          this.properties.push(getValuePrimitive(p));
          break;
        }
        case 'no-cache': {
          if (getValuePrimitive(p) === 'true') this.uid = crypto.randomUUID();
          break;
        }
        case '_incomplete':
        case 'limitedExpansion': {
          let value = getValuePrimitive(p);
          this.limitedExpansion = strToBool(value, false);
          break;
        }
        case 'includeDesignations': {
          let value = getValuePrimitive(p);
          this.includeDesignations = strToBool(value, false);
          break;
        }
        case 'includeDefinition': {
          let value = getValuePrimitive(p);
          this.includeDefinition = strToBool(value, false);
          break;
        }
        case 'activeOnly': {
          let value = getValuePrimitive(p);
          this.activeOnly = strToBool(value, false);
          break;
        }
        case 'excludeNested': {
          let value = getValuePrimitive(p);
          this.excludeNested = strToBool(value, false);
          break;
        }
        case 'excludeNotForUI': {
          let value = getValuePrimitive(p);
          this.excludeNotForUI = strToBool(value, false);
          break;
        }
        case 'excludePostCoordinated': {
          let value = getValuePrimitive(p);
          this.excludePostCoordinated = strToBool(value, false);
          break;
        }
        case 'default-to-latest-version': {
          let value = getValuePrimitive(p);
          this.defaultToLatestVersion = strToBool(value, false);
          break;
        }
        case 'incomplete-ok': {
          let value = getValuePrimitive(p);
          this.incompleteOK = strToBool(value, false);
          break;
        }
        case 'diagnostics': {
          let value = getValuePrimitive(p);
          this.diagnostics = strToBool(value, false);
          break;
        }
        case 'lenient-display-validation': {
          if (getValuePrimitive(p) == true) this.displayWarning = true;
          break;
        }
        case 'valueset-membership-only': {
          if (getValuePrimitive(p) == true) this.membershipOnly = true;
          break;
        }
        case 'profile' : {
          let value = p.resource;
          if (value && (value.resourceType === 'Parameters' || value.resourceType === 'ExpansionProfile')) {
            this.readParams(value);
          }
          break;
        }
        // eslint-disable-next-line no-fallthrough
        case 'term': // jQuery support
        case 'filter' : {
          this.filter = getValuePrimitive(p);
          break;
        }
        case 'count' : {
          this.count = Utilities.parseIntOrDefault(getValuePrimitive(p), -1);
          break;
        }
        case 'offset' : {
          this.offset = Utilities.parseIntOrDefault(getValuePrimitive(p), -1);
          break;
        }

        case 'limit' : {
          this.limit = Utilities.parseIntOrDefault(getValuePrimitive(p), -1);
          break;
        }

        case 'useSupplement' : {
          this.supplements.add(getValuePrimitive(p));
          break;
        }

        case 'abstract': {
          if (getValuePrimitive(p) == true) {
            this.abstractOk = true;
          } else if (getValuePrimitive(p) == false) {
            this.abstractOk = false;
          }
          break;
        }
        case 'inferSystem': {
          if (getValuePrimitive(p) == true) this.inferSystem = true;
          break;
        }
        case "exclude-system": {
          throw new Issue('error', 'not-supported', null, null, "The parameter 'exclude-system' is not supported by this system", null, 400);
        }
      }
    }

  }

  paramstr(params, name) {
    if (params.parameter) {
      for (let p of params.parameter) {
        if (p.name == name) {
          return getValuePrimitive(p);
        }
      }
    }
  }

  hasParam(params, name) {
    return params.parameter && params.parameter.find(p => p.name == name);
  }

  get HTTPLanguages() {
    return this.FHTTPLanguages;
  }

  set HTTPLanguages(value) {
    this.FHTTPLanguages = value;
  }

  get DisplayLanguages() {
    return this.FDisplayLanguages;
  }

  set DisplayLanguages(value) {
    this.FDisplayLanguages = value;
  }

  get hasHTTPLanguages() {
    return this.FHTTPLanguages && this.FHTTPLanguages.source;
  }

  get hasDisplayLanguages() {
    return this.FDisplayLanguages && this.FDisplayLanguages.source;
  }

  get hasDesignations() {
    return this.FDesignations.length > 0;
  }

  get activeOnly() {
    return this.FActiveOnly;
  }

  set activeOnly(value) {
    this.FActiveOnly = value;
    this.hasActiveOnly = true;
  }

  get excludeNested() {
    return this.FExcludeNested;
  }

  set excludeNested(value) {
    this.FExcludeNested = value;
    this.hasExcludeNested = true;
  }

  get generateNarrative() {
    return this.FGenerateNarrative;
  }

  set generateNarrative(value) {
    this.FGenerateNarrative = value;
    this.hasGenerateNarrative = true;
  }

  get excludeNotForUI() {
    return this.FExcludeNotForUI;
  }

  set excludeNotForUI(value) {
    this.FExcludeNotForUI = value;
    this.hasExcludeNotForUI = true;
  }

  get excludePostCoordinated() {
    return this.FExcludePostCoordinated;
  }

  set excludePostCoordinated(value) {
    this.FExcludePostCoordinated = value;
    this.hasExcludePostCoordinated = true;
  }

  get includeDesignations() {
    return this.FIncludeDesignations;
  }

  set includeDesignations(value) {
    this.FIncludeDesignations = value;
    this.hasIncludeDesignations = true;
  }

  get includeDefinition() {
    return this.FIncludeDefinition;
  }

  set includeDefinition(value) {
    this.FIncludeDefinition = value;
    this.hasIncludeDefinition = true;
  }

  get defaultToLatestVersion() {
    return this.FDefaultToLatestVersion;
  }

  set defaultToLatestVersion(value) {
    this.FDefaultToLatestVersion = value;
    this.hasDefaultToLatestVersion = true;
  }

  get displayWarning() {
    return this.FDisplayWarning;
  }

  set displayWarning(value) {
    this.FDisplayWarning = value;
    this.hasDisplayWarning = true;
  }

  get membershipOnly() {
    return this.FMembershipOnly;
  }

  set membershipOnly(value) {
    this.FMembershipOnly = value;
    this.hasMembershipOnly = true;
  }

  get versionRules() {
    return this.FVersionRules;
  }

  get properties() {
    return this.FProperties;
  }

  get designations() {
    return this.FDesignations;
  }

  static defaultProfile(langDefs) {
    return new TxParameters(langDefs);
  }

  seeParameter(name, value, overwrite) {
    if (value) {
      if (name === 'displayLanguage' && (!this.FDisplayLanguages || overwrite)) {
        this.DisplayLanguages = Languages.fromAcceptLanguage(getValuePrimitive(value), this.languageDefinitions, !this.validating)
      }

      if (name === 'designation') {
        this.designations.push(getValuePrimitive(value));
      }
    }
  }

  getVersionForRule(systemURI, mode) {
    for (let rule of this.FVersionRules) {
      if (rule.system === systemURI && rule.mode === mode) {
        return rule.version;
      }
    }
    return '';
  }

  rulesForSystem(systemURI) {
    let result = [];
    for (let t of this.FVersionRules) {
      if (t.system === systemURI) {
        result.push(t);
      }
    }
    return result;
  }

  seeVersionRule(url, vs, mode) {
    let sl = url ? url.split('|') : [];
    if (sl.length === 2) {
      this.versionRules.push(new VersionRule(sl[0], sl[1], vs, mode));
    } else {
      throw new Error('Unable to understand ' + mode + ' system version "' + url + '"');
    }
  }

  workingLanguages() {
    if (this.FDisplayLanguages) {
      return this.FDisplayLanguages;
    } else {
      return this.FHTTPLanguages;
    }
  }

  langSummary() {
    if (this.FDisplayLanguages) {
      return this.FDisplayLanguages.asString(false);
    } else if (this.FHTTPLanguages) {
      return this.FHTTPLanguages.asString(false);
    } else {
      return '--';
    }
  }

  summary() {
    let result = '';

    const commaAdd = (r, s) => {
      if (!r) return s;
      return r + ', ' + s;
    };

    const b = (s, v) => {
      if (v) {
        result = commaAdd(result, s);
      }
    };

    const sv = (s, v) => {
      if (v) {
        result = commaAdd(result, s + '=' + v);
      }
    };

    sv('uid', this.FUid);
    if (this.FProperties) {
      sv('properties', this.FProperties.join(','));
    }
    if (this.FHTTPLanguages) {
      sv('http-lang', this.FHTTPLanguages.asString(true));
    }
    if (this.FDisplayLanguages) {
      sv('disp-lang', this.FDisplayLanguages.asString(true));
    }
    if (this.FDesignations) {
      sv('designations', this.FDesignations.join(','));
    }
    b('active-only', this.FActiveOnly);
    b('exclude-nested', this.FExcludeNested);
    b('generate-narrative', this.FGenerateNarrative);
    b('for-ui', this.FExcludeNotForUI);
    b('exclude-post-coordinated', this.FExcludePostCoordinated);
    b('include-designations', this.FIncludeDesignations);
    b('include-definition', this.FIncludeDefinition);
    b('membership-only', this.FMembershipOnly);
    b('default-to-latest', this.FDefaultToLatestVersion);
    b('display-warning', this.FDisplayWarning);

    return result;
  }

  verSummary() {
    let result = '';
    for (let p of this.FVersionRules) {
      if (!result) {
        result = p.asString();
      } else {
        result = result + ', ' + p.asString();
      }
    }
    return result;
  }

  hashSource() {
    const b = (v) => {
      return v ? '1|' : '0|';
    };

    let s = '|'+this.count+'|'+this.limit+'|'+this.offset+'|f='+(this.filter || '')+
      this.FUid + '|' + b(this.FMembershipOnly) + '|' + this.FProperties.join(',') + '|' +
      b(this.FActiveOnly) + b(this.FDisplayWarning) + b(this.FExcludeNested) + b(this.FGenerateNarrative) + b(this.FExcludeNotForUI) + b(this.FExcludePostCoordinated) +
      b(this.FIncludeDesignations) + b(this.FIncludeDefinition) + b(this.hasActiveOnly) + b(this.hasExcludeNested) + b(this.hasGenerateNarrative) +
      b(this.hasExcludeNotForUI) + b(this.hasExcludePostCoordinated) + b(this.hasIncludeDesignations) +
      b(this.hasIncludeDefinition) + b(this.hasDefaultToLatestVersion) + b(this.hasDisplayWarning) + b(this.hasExcludeNotForUI) + b(this.hasMembershipOnly) + b(this.FDefaultToLatestVersion);

    if (this.hasHTTPLanguages) {
      s = s + this.FHTTPLanguages.asString(true) + '|';
    }
    if (this.hasDisplayLanguages) {
      s = s + '*' + this.FDisplayLanguages.asString(true) + '|';
    }
    if (this.hasDesignations) {
      s = s + this.FDesignations.join(',') + '|';
    }
    for (let t of this.FVersionRules) {
      s = s + t.asString() + '|';
    }
    for (let t of this.FValueSetVersionRules || []) {
      s = s + t.asString() + '|';
    }

    return s;
  }

  link() {
    return this;
  }

  clone() {
    let result = new TxParameters(this.languageDefinitions, this.i18n, this.validating);
    result.assign(this);
    return result;
  }

  assign(other) {
    this.count = other.count;
    this.limit = other.limit;
    this.offset = other.offset;
    this.filter = other.filter;
    this.limitedExpansion = other.limitedExpansion;
    this.incompleteOK = other.incompleteOK;
    this.abstractOk = other.abstractOk;
    this.inferSystem = other.inferSystem;
    this.supplements = new Set(other.supplements || []);

    if (other.FVersionRules) {
      this.FVersionRules = [...other.FVersionRules];
    }
    if (other.FValueSetVersionRules) {
      this.FValueSetVersionRules = [...other.FValueSetVersionRules];
    }
    this.FActiveOnly = other.FActiveOnly;
    this.FExcludeNested = other.FExcludeNested;
    this.FGenerateNarrative = other.FGenerateNarrative;
    this.FExcludeNotForUI = other.FExcludeNotForUI;
    this.FExcludePostCoordinated = other.FExcludePostCoordinated;
    this.FIncludeDesignations = other.FIncludeDesignations;
    this.FIncludeDefinition = other.FIncludeDefinition;
    this.FUid = other.FUid;
    this.FMembershipOnly = other.FMembershipOnly;
    this.FDefaultToLatestVersion = other.FDefaultToLatestVersion;
    this.FDisplayWarning = other.FDisplayWarning;
    this.FDiagnostics = other.FDiagnostics;
    this.hasActiveOnly = other.hasActiveOnly;
    this.hasExcludeNested = other.hasExcludeNested;
    this.hasGenerateNarrative = other.hasGenerateNarrative;
    this.hasExcludeNotForUI = other.hasExcludeNotForUI;
    this.hasExcludePostCoordinated = other.hasExcludePostCoordinated;
    this.hasIncludeDesignations = other.hasIncludeDesignations;
    this.hasIncludeDefinition = other.hasIncludeDefinition;
    this.hasDefaultToLatestVersion = other.hasDefaultToLatestVersion;
    this.hasMembershipOnly = other.hasMembershipOnly;
    this.hasDisplayWarning = other.hasDisplayWarning;

    if (other.FProperties) {
      this.FProperties = [...other.FProperties];
    }

    if (other.FDesignations) {
      this.FDesignations = [...other.FDesignations];
    }

    if (other.FHTTPLanguages) {
      this.FHTTPLanguages = other.FHTTPLanguages;
    }
    if (other.FDisplayLanguages) {
      this.FDisplayLanguages = other.FDisplayLanguages;
    }
  }

  logInfo() {
    return ""; // any parameters worth logging
  }
}

module.exports = { TxParameters, VersionRule };
