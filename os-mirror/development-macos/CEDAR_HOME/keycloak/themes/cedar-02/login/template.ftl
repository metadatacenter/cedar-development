<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"  "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" class="${properties.kcHtmlClass!}">

<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="robots" content="noindex, nofollow">

    <#if properties.meta?has_content>
        <#list properties.meta?split(' ') as meta>
            <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
        </#list>
    </#if>
    <title><#nested "title"></title>
    <link rel="icon" href="${url.resourcesPath}/img/favicon.ico" />
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
</head>

<body style="font-family: Helvetica Neue, Helvetica, Arial, sans-serif;
    font-weight: 400;
    font-size:14px;color: #333;
    height: 100%;
    overflow: hidden;
    display:flex;
    justify-content: center;
    align-items: center;
    ">

    <div id="content-wrapper" >
        <div id="content-wrapper-padding" >
            <#if realm.internationalizationEnabled>
                <div id="kc-locale" class="${properties.kcLocaleClass!}">
                    <div id="kc-locale-wrapper" class="${properties.kcLocaleWrapperClass!}">
                        <div class="kc-dropdown" id="kc-locale-dropdown">
                            <a href="#" id="kc-current-locale-link">${locale.current}</a>
                            <ul>
                                <#list locale.supported as l>
                                    <li class="kc-dropdown-item"><a href="${l.url}">${l.label}</a></li>
                                </#list>
                            </ul>
                        </div>
                    </div>
                </div>
            </#if>

            <div id="kc-content" >

                <div class="row" >
                    <div id="kc-content-wrapper">
		        <a href="https://cedar.staging.metadatacenter.org"><div id="cedar-small-logo" ><span class="pajama-header"><#nested "header"></span></div></a>
                            <#if displayMessage && message?has_content>
                                <div class="${properties.kcFeedbackAreaClass!}">
                                    <div class="alert alert-${message.type}">
                                        <#if message.type = 'success'><span class="${properties.kcFeedbackSuccessIcon!}"></span></#if>
                                        <#if message.type = 'warning'><span class="${properties.kcFeedbackWarningIcon!}"></span></#if>
                                        <#if message.type = 'error'><span class="${properties.kcFeedbackErrorIcon!}"></span></#if>
                                        <#if message.type = 'info'><span class="${properties.kcFeedbackInfoIcon!}"></span></#if>
                                        <span class="kc-feedback-text">${message.summary}</span>
                                    </div>
                                </div>
                            </#if>

                        <div id="kc-form" >
                            <div id="kc-form-wrapper"  >
                                <#nested "form">
                            </div>
                        </div>

                        <#if displayInfo>
                            <div id="kc-info" >
                                <div id="kc-info-wrapper">
                                    <#nested "info">
                                </div>
                            </div>
                        </#if>
                    </div>
                </div>
            </div>
        </div>

        <div id="kc-video">
            <a  target="_blank" href="https://www.youtube.com/watch?v=1NBYWOKo9qo&list=PLRFrKQ_tBSltHFumG7TLkpuLGv_dz8xwO" >Watch the video tutorial</a> 
        </div>

    </div>

</body>
</html>
</#macro>
