import _ from 'lodash';
import B from 'bluebird';
import path from 'path';
import resolveFrom from 'resolve-from';
import {satisfies} from 'semver';
import {util} from '@appium/support';
import {commandClasses} from '../cli/extension';
import {APPIUM_VER} from '../config';
import log from '../logger';
import {
  ALLOWED_SCHEMA_EXTENSIONS,
  isAllowedSchemaFileExtension,
  registerSchema,
} from '../schema/schema';

const INSTALL_TYPE_NPM = 'npm';
const INSTALL_TYPE_LOCAL = 'local';
const INSTALL_TYPE_GITHUB = 'github';
const INSTALL_TYPE_GIT = 'git';

/** @type {Set<InstallType>} */
const INSTALL_TYPES = new Set([
  INSTALL_TYPE_GIT,
  INSTALL_TYPE_GITHUB,
  INSTALL_TYPE_LOCAL,
  INSTALL_TYPE_NPM,
]);

/**
 * This class is abstract. It should not be instantiated directly.
 *
 * Subclasses should provide the generic parameter to implement.
 * @template {ExtensionType} ExtType
 */
export class ExtensionConfig {
  /** @type {ExtType} */
  extensionType;

  /** @type {`${ExtType}s`} */
  configKey;

  /** @type {ExtRecord<ExtType>} */
  installedExtensions;

  /** @type {import('@appium/types').AppiumLogger} */
  log;

  /** @type {Manifest} */
  manifest;

  /**
   * @type {ExtensionListData}
   */
  _listDataCache;

  /**
   * @protected
   * @param {ExtType} extensionType - Type of extension
   * @param {Manifest} manifest - `Manifest` instance
   */
  constructor(extensionType, manifest) {
    this.extensionType = extensionType;
    this.configKey = `${extensionType}s`;
    this.installedExtensions = manifest.getExtensionData(extensionType);
    this.manifest = manifest;
  }

  get manifestPath() {
    return this.manifest.manifestPath;
  }

  get appiumHome() {
    return this.manifest.appiumHome;
  }

  /**
   * Returns a list of errors for a given extension.
   *
   * @param {ExtName<ExtType>} extName
   * @param {ExtManifest<ExtType>} extManifest
   * @returns {ExtManifestProblem[]}
   */
  getProblems(extName, extManifest) {
    return [
      ...this.getGenericConfigProblems(extManifest, extName),
      ...this.getConfigProblems(extManifest, extName),
      ...this.getSchemaProblems(extManifest, extName),
    ];
  }

  /**
   * Returns a list of warnings for a given extension.
   *
   * @param {ExtName<ExtType>} extName
   * @param {ExtManifest<ExtType>} extManifest
   * @returns {Promise<string[]>}
   */
  async getWarnings(extName, extManifest) {
    const [genericConfigWarnings, configWarnings] = await B.all([
      this.getGenericConfigWarnings(extManifest, extName),
      this.getConfigWarnings(extManifest, extName),
    ]);

    return [...genericConfigWarnings, ...configWarnings];
  }

  /**
   * Returns a list of extension-type-specific issues. To be implemented by subclasses.
   * @abstract
   * @param {ExtManifest<ExtType>} extManifest
   * @param {ExtName<ExtType>} extName
   * @returns {Promise<string[]>}
   */
  // eslint-disable-next-line no-unused-vars,require-await
  async getConfigWarnings(extManifest, extName) {
    return [];
  }

  /**
   *
   * @param {Map<ExtName<ExtType>,ExtManifestProblem[]>} [errorMap]
   * @param {Map<ExtName<ExtType>,string[]>} [warningMap]
   */
  getValidationResultSummaries(errorMap = new Map(), warningMap = new Map()) {
    /**
     * Array of computed strings
     * @type {string[]}
     */
    const errorSummaries = [];
    for (const [extName, problems] of errorMap.entries()) {
      if (_.isEmpty(problems)) {
        continue;
      }
      // remove this extension from the list since it's not valid
      errorSummaries.push(
        `${this.extensionType} "${extName}" had ${util.pluralize(
          'error',
          problems.length
        )} and will not be available:`
      );
      for (const problem of problems) {
        errorSummaries.push(
          `  - ${problem.err} (Actual value: ` + `${JSON.stringify(problem.val)})`
        );
      }
    }
    /** @type {string[]} */
    const warningSummaries = [];
    for (const [extName, warnings] of warningMap.entries()) {
      if (_.isEmpty(warnings)) {
        continue;
      }
      const extTypeText = _.capitalize(this.extensionType);
      const problemEnumerationText = util.pluralize('potential problem', warnings.length, true);
      warningSummaries.push(`${extTypeText} "${extName}" has ${problemEnumerationText}: `);
      for (const warning of warnings) {
        warningSummaries.push(`  - ${warning}`);
      }
    }

    return {errorSummaries, warningSummaries};
  }

  /**
   * Checks extensions for problems.  To be called by subclasses' `validate` method.
   *
   * Errors and warnings will be displayed to the user.
   *
   * This method mutates `exts`.
   *
   * @protected
   * @param {ExtRecord<ExtType>} exts - Lookup of extension names to {@linkcode ExtManifest} objects
   * @returns {Promise<ExtRecord<ExtType>>} The same lookup, but picking only error-free extensions
   */
  async _validate(exts) {
    /**
     * Lookup of extension names to {@linkcode ExtManifestProblem ExtManifestProblems}
     * @type {Map<ExtName<ExtType>,ExtManifestProblem[]>}
     */
    const errorMap = new Map();
    /**
     * Lookup of extension names to warnings.
     * @type {Map<ExtName<ExtType>,string[]>}
     */
    const warningMap = new Map();

    for (const [extName, extManifest] of _.toPairs(exts)) {
      const [errors, warnings] = await B.all([
        this.getProblems(extName, extManifest),
        this.getWarnings(extName, extManifest),
      ]);
      if (errors.length) {
        delete exts[extName];
      }
      errorMap.set(extName, errors);
      warningMap.set(extName, warnings);
    }

    const {errorSummaries, warningSummaries} = this.getValidationResultSummaries(
      errorMap,
      warningMap
    );

    if (!_.isEmpty(errorSummaries)) {
      log.error(
        `Appium encountered ${util.pluralize(
          'error',
          errorSummaries.length,
          true
        )} while validating ${this.configKey} found in manifest ${this.manifestPath}`
      );
      for (const summary of errorSummaries) {
        log.error(summary);
      }
    } else {
      // only display warnings if there are no errors!

      if (!_.isEmpty(warningSummaries)) {
        log.warn(
          `Appium encountered ${util.pluralize(
            'warning',
            warningSummaries.length,
            true
          )} while validating ${this.configKey} found in manifest ${this.manifestPath}`
        );
        for (const summary of warningSummaries) {
          log.warn(summary);
        }
      }
    }
    return exts;
  }

  /**
   * Retrieves listing data for extensions via command class.
   * Caches the result in {@linkcode ExtensionConfig._listDataCache}
   * @protected
   * @returns {Promise<ExtensionListData>}
   */
  async getListData() {
    if (this._listDataCache) {
      return this._listDataCache;
    }
    const CommandClass = /** @type {ExtCommand<ExtType>} */ (commandClasses[this.extensionType]);
    const cmd = new CommandClass({config: this, json: true});
    const listData = await cmd.list({showInstalled: true, showUpdates: true});
    this._listDataCache = listData;
    return listData;
  }

  /**
   * Returns a list of warnings for a particular extension.
   *
   * By definition, a non-empty list of warnings does _not_ imply the extension cannot be loaded,
   * but it may not work as expected or otherwise throw an exception at runtime.
   *
   * @param {ExtManifest<ExtType>} extManifest
   * @param {ExtName<ExtType>} extName
   * @returns {Promise<string[]>}
   */
  async getGenericConfigWarnings(extManifest, extName) {
    const {appiumVersion, installSpec, installType, pkgName} = extManifest;
    const warnings = [];

    const invalidFields = [];
    if (!_.isString(installSpec)) {
      invalidFields.push('installSpec');
    }

    if (!INSTALL_TYPES.has(installType)) {
      invalidFields.push('installType');
    }

    const extTypeText = _.capitalize(this.extensionType);

    if (invalidFields.length) {
      const invalidFieldsEnumerationText = util.pluralize(
        'invalid or missing field',
        invalidFields.length,
        true
      );
      const invalidFieldsText = invalidFields.map((field) => `"${field}"`).join(', ');

      warnings.push(
        `${extTypeText} "${extName}" (package \`${pkgName}\`) has ${invalidFieldsEnumerationText} (${invalidFieldsText}) in \`extensions.yaml\`; this may cause upgrades done via the \`appium\` CLI tool to fail. Please reinstall with \`appium ${this.extensionType} uninstall ${extName}\` and \`appium ${this.extensionType} install ${extName}\` to attempt a fix.`
      );
    }

    /**
     * Helps concatenate warning messages related to peer dependencies
     * @param {string} reason
     * @returns string
     */
    const createPeerWarning = (reason) =>
      `${extTypeText} "${extName}" (package \`${pkgName}\`) may be incompatible with the current version of Appium (v${APPIUM_VER}) due to ${reason}`;

    if (_.isString(appiumVersion) && !satisfies(APPIUM_VER, appiumVersion)) {
      const listData = await this.getListData();
      const extListData = /** @type {InstalledExtensionListData} */ (listData[extName]);
      if (extListData?.installed) {
        const {updateVersion, upToDate} = extListData;
        if (!upToDate) {
          warnings.push(
            createPeerWarning(
              `its peer dependency on older Appium v${appiumVersion}. Please upgrade \`${pkgName}\` to v${updateVersion} or newer.`
            )
          );
        } else {
          warnings.push(
            createPeerWarning(
              `its peer dependency on older Appium v${appiumVersion}. Please ask the developer of \`${pkgName}\` to update the peer dependency on Appium to v${APPIUM_VER}.`
            )
          );
        }
      }
    } else if (!_.isString(appiumVersion)) {
      const listData = await this.getListData();
      const extListData = /** @type {InstalledExtensionListData} */ (listData[extName]);
      if (!extListData?.upToDate && extListData?.updateVersion) {
        warnings.push(
          createPeerWarning(
            `an invalid or missing peer dependency on Appium. A newer version of \`${pkgName}\` is available; please attempt to upgrade "${extName}" to v${extListData.updateVersion} or newer.`
          )
        );
      } else {
        warnings.push(
          createPeerWarning(
            `an invalid or missing peer dependency on Appium. Please ask the developer of \`${pkgName}\` to add a peer dependency on \`^appium@${APPIUM_VER}\`.`
          )
        );
      }
    }
    return warnings;
  }
  /**
   * Returns list of unrecoverable errors (if any) for the given extension _if_ it has a `schema` property.
   *
   * @param {ExtManifest<ExtType>} extManifest - Extension data (from manifest)
   * @param {ExtName<ExtType>} extName - Extension name (from manifest)
   * @returns {ExtManifestProblem[]}
   */
  getSchemaProblems(extManifest, extName) {
    /** @type {ExtManifestProblem[]} */
    const problems = [];
    const {schema: argSchemaPath} = extManifest;
    if (ExtensionConfig.extDataHasSchema(extManifest)) {
      if (_.isString(argSchemaPath)) {
        if (isAllowedSchemaFileExtension(argSchemaPath)) {
          try {
            this.readExtensionSchema(extName, extManifest);
          } catch (err) {
            problems.push({
              err: `Unable to register schema at path ${argSchemaPath}; ${err.message}`,
              val: argSchemaPath,
            });
          }
        } else {
          problems.push({
            err: `Schema file has unsupported extension. Allowed: ${[
              ...ALLOWED_SCHEMA_EXTENSIONS,
            ].join(', ')}`,
            val: argSchemaPath,
          });
        }
      } else if (_.isPlainObject(argSchemaPath)) {
        try {
          this.readExtensionSchema(extName, extManifest);
        } catch (err) {
          problems.push({
            err: `Unable to register embedded schema; ${err.message}`,
            val: argSchemaPath,
          });
        }
      } else {
        problems.push({
          err: 'Incorrectly formatted schema field; must be a path to a schema file or a schema object.',
          val: argSchemaPath,
        });
      }
    }
    return problems;
  }

  /**
   * Return a list of generic unrecoverable errors for the given extension
   * @param {ExtManifest<ExtType>} extManifest - Extension data (from manifest)
   * @param {ExtName<ExtType>} extName - Extension name (from manifest)
   * @returns {ExtManifestProblem[]}
   */
  // eslint-disable-next-line no-unused-vars
  getGenericConfigProblems(extManifest, extName) {
    const {version, pkgName, mainClass} = extManifest;
    const problems = [];

    if (!_.isString(version)) {
      problems.push({
        err: `Invalid or missing \`version\` field in my \`package.json\` and/or \`extensions.yaml\` (must be a string)`,
        val: version,
      });
    }

    if (!_.isString(pkgName)) {
      problems.push({
        err: `Invalid or missing \`name\` field in my \`package.json\` and/or \`extensions.yaml\` (must be a string)`,
        val: pkgName,
      });
    }

    if (!_.isString(mainClass)) {
      problems.push({
        err: `Invalid or missing \`appium.mainClass\` field in my \`package.json\` and/or \`mainClass\` field in \`extensions.yaml\` (must be a string)`,
        val: mainClass,
      });
    }

    return problems;
  }

  /**
   * @abstract
   * @param {ExtManifest<ExtType>} extManifest
   * @param {ExtName<ExtType>} extName
   * @returns {ExtManifestProblem[]}
   */
  // eslint-disable-next-line no-unused-vars
  getConfigProblems(extManifest, extName) {
    // shoud override this method if special validation is necessary for this extension type
    return [];
  }

  /**
   * @param {string} extName
   * @param {ExtManifest<ExtType>} extManifest
   * @param {ExtensionConfigMutationOpts} [opts]
   * @returns {Promise<void>}
   */
  async addExtension(extName, extManifest, {write = true} = {}) {
    this.manifest.addExtension(this.extensionType, extName, extManifest);
    if (write) {
      await this.manifest.write();
    }
  }

  /**
   * @param {ExtName<ExtType>} extName
   * @param {ExtManifest<ExtType>|import('../cli/extension-command').ExtensionFields<ExtType>} extManifest
   * @param {ExtensionConfigMutationOpts} [opts]
   * @returns {Promise<void>}
   */
  async updateExtension(extName, extManifest, {write = true} = {}) {
    this.installedExtensions[extName] = {
      ...this.installedExtensions[extName],
      ...extManifest,
    };
    if (write) {
      await this.manifest.write();
    }
  }

  /**
   * Remove an extension from the list of installed extensions, and optionally avoid a write to the manifest file.
   *
   * @param {ExtName<ExtType>} extName
   * @param {ExtensionConfigMutationOpts} [opts]
   * @returns {Promise<void>}
   */
  async removeExtension(extName, {write = true} = {}) {
    delete this.installedExtensions[extName];
    if (write) {
      await this.manifest.write();
    }
  }

  /**
   * @param {ExtName<ExtType>[]} [activeNames]
   * @returns {void}
   */
  // eslint-disable-next-line no-unused-vars
  print(activeNames) {
    if (_.isEmpty(this.installedExtensions)) {
      log.info(
        `No ${this.configKey} have been installed in ${this.appiumHome}. Use the "appium ${this.extensionType}" ` +
          'command to install the one(s) you want to use.'
      );
      return;
    }

    log.info(`Available ${this.configKey}:`);
    for (const [extName, extManifest] of /** @type {[string, ExtManifest<ExtType>][]} */ (
      _.toPairs(this.installedExtensions)
    )) {
      log.info(`  - ${this.extensionDesc(extName, extManifest)}`);
    }
  }

  /**
   * Returns a string describing the extension. Subclasses must implement.
   * @param {ExtName<ExtType>} extName - Extension name
   * @param {ExtManifest<ExtType>} extManifest - Extension data
   * @returns {string}
   * @abstract
   */
  // eslint-disable-next-line no-unused-vars
  extensionDesc(extName, extManifest) {
    throw new Error('This must be implemented in a subclass');
  }

  /**
   * @param {string} extName
   * @returns {string}
   */
  getInstallPath(extName) {
    return path.join(this.appiumHome, 'node_modules', this.installedExtensions[extName].pkgName);
  }

  /**
   * Loads extension and returns its main class (constructor)
   * @param {ExtName<ExtType>} extName
   * @returns {ExtClass<ExtType>}
   */
  require(extName) {
    const {mainClass} = this.installedExtensions[extName];
    const reqPath = this.getInstallPath(extName);
    const reqResolved = require.resolve(reqPath);
    // note: this will only reload the entry point
    if (process.env.APPIUM_RELOAD_EXTENSIONS && require.cache[reqResolved]) {
      log.debug(`Removing ${reqResolved} from require cache`);
      delete require.cache[reqResolved];
    }
    log.debug(`Requiring ${this.extensionType} at ${reqPath}`);
    return require(reqPath)[mainClass];
  }

  /**
   * @param {string} extName
   * @returns {boolean}
   */
  isInstalled(extName) {
    return _.includes(Object.keys(this.installedExtensions), extName);
  }

  /**
   * Intended to be called by corresponding instance methods of subclass.
   * @private
   * @template {ExtensionType} ExtType
   * @param {string} appiumHome
   * @param {ExtType} extType
   * @param {ExtName<ExtType>} extName - Extension name (unique to its type)
   * @param {ExtManifestWithSchema<ExtType>} extManifest - Extension config
   * @returns {import('ajv').SchemaObject|undefined}
   */
  static _readExtensionSchema(appiumHome, extType, extName, extManifest) {
    const {pkgName, schema: argSchemaPath} = extManifest;
    if (!argSchemaPath) {
      throw new TypeError(
        `No \`schema\` property found in config for ${extType} ${pkgName} -- why is this function being called?`
      );
    }
    let moduleObject;
    if (_.isString(argSchemaPath)) {
      const schemaPath = resolveFrom(appiumHome, path.join(pkgName, argSchemaPath));
      moduleObject = require(schemaPath);
    } else {
      moduleObject = argSchemaPath;
    }
    // this sucks. default exports should be destroyed
    const schema = moduleObject.__esModule ? moduleObject.default : moduleObject;
    registerSchema(extType, extName, schema);
    return schema;
  }

  /**
   * Returns `true` if a specific {@link ExtManifest} object has a `schema` prop.
   * The {@link ExtManifest} object becomes a {@link ExtManifestWithSchema} object.
   * @template {ExtensionType} ExtType
   * @param {ExtManifest<ExtType>} extManifest
   * @returns {extManifest is ExtManifestWithSchema<ExtType>}
   */
  static extDataHasSchema(extManifest) {
    return _.isString(extManifest?.schema) || _.isObject(extManifest?.schema);
  }

  /**
   * If an extension provides a schema, this will load the schema and attempt to
   * register it with the schema registrar.
   * @param {ExtName<ExtType>} extName - Name of extension
   * @param {ExtManifestWithSchema<ExtType>} extManifest - Extension data
   * @returns {import('ajv').SchemaObject|undefined}
   */
  readExtensionSchema(extName, extManifest) {
    return ExtensionConfig._readExtensionSchema(
      this.appiumHome,
      this.extensionType,
      extName,
      extManifest
    );
  }
}

export {INSTALL_TYPE_NPM, INSTALL_TYPE_GIT, INSTALL_TYPE_LOCAL, INSTALL_TYPE_GITHUB, INSTALL_TYPES};

/**
 * An issue with the {@linkcode ExtManifest} for a particular extension.
 *
 * The existance of such an object implies that the extension cannot be loaded.
 * @typedef ExtManifestProblem
 * @property {string} err - Error message
 * @property {any} val - Associated value
 */

/**
 * An optional logging function provided to an {@link ExtensionConfig} subclass.
 * @callback ExtensionLogFn
 * @param {...any} args
 * @returns {void}
 */

/**
 * @typedef {import('@appium/types').ExtensionType} ExtensionType
 * @typedef {import('./manifest').Manifest} Manifest
 */

/**
 * @template T
 * @typedef {import('appium/types').ExtManifest<T>} ExtManifest
 */

/**
 * @template T
 * @typedef {import('appium/types').ExtManifestWithSchema<T>} ExtManifestWithSchema
 */

/**
 * @template T
 * @typedef {import('appium/types').ExtName<T>} ExtName
 */

/**
 * @template T
 * @typedef {import('appium/types').ExtClass<T>} ExtClass
 */

/**
 * @template T
 * @typedef {import('appium/types').ExtRecord<T>} ExtRecord
 */

/**
 * @template T
 * @typedef {import('../cli/extension').ExtCommand<T>} ExtCommand
 */

/**
 * Options for various methods in {@link ExtensionConfig}
 * @typedef ExtensionConfigMutationOpts
 * @property {boolean} [write=true] Whether or not to write the manifest to disk after a mutation operation
 */

/**
 * A valid install type
 * @typedef {typeof INSTALL_TYPE_NPM | typeof INSTALL_TYPE_GIT | typeof INSTALL_TYPE_LOCAL | typeof INSTALL_TYPE_GITHUB} InstallType
 */

/**
 * @typedef {import('../cli/extension-command').ExtensionListData} ExtensionListData
 * @typedef {import('../cli/extension-command').InstalledExtensionListData} InstalledExtensionListData
 */
