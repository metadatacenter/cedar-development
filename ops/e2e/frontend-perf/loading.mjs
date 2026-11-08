import {loadingFailures} from './paired.mjs';

// Application and local API origins used by the modern sweep. No production or third-party
// request is needed by its fixed text-field fixtures and empty terminology picker.
const hosts=['workspace','designer','openview','monitoring','bridging','content','performance',
  'auth','resource','user','open','monitor','terminology','bridge','worker','messaging','group'];
export function modernLoadingFailures(network, scenario, domain) {
  const deferred=[];
  if(['workspace-dashboard','bridging-dashboard'].includes(scenario))
    deferred.push(/\/cedar-embeddable-(?:editor|designer)(?:\.host-fonts)?\.js$/);
  if(scenario.startsWith('designer-') || scenario.startsWith('ced-integrated-'))
    deferred.push(/\/cedar-rdf-/,/\/cedar-schema-validation\.mjs$/);
  return loadingFailures(network,hosts.map(host=>`https://${host}.${domain}`),deferred);
}
