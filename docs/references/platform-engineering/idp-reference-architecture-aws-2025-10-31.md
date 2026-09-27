## Reference architecture _of_ an Internal Developer Platform on AWS 

```
WEAVE INTELLIGENCE PRESENTS
REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
PUBLISHED IN 2025
```



```
1REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

#### Reference architecture of an Internal Developer Platform on AWS 

##### Table contents _of_ 

|Introduction|`03`|
|---|---|
|Overview of changes in|`05`|
|version 2.0||
|Multi-platform reality|`06`|
|Code as truth, interface as enabler|`06`|
|Central backend still rules|`06`|
|Security frst|`06`|
|Roles and responsibilities|`07`|
|Design principles|`08`|
|Deep dive|`10`|
|The Developer Control Plane|`12`|
|IDE and CDE|`12`|
|Portals|`13`|
|Copilot, LLM, agents|`13`|
|The Integration and Delivery Plane|`14`|
|Structuring your Version Control System (VCS)|`15`|
|CI pipeline|`15`|
|Image registry|`16`|
|Platform Orchestrator|`16`|
|CD system|`16`|



|The Resource Plane|`17`|
|---|---|
|Security Plane|`18`|
|Code analysis|`18`|
|Secrets management|`18`|
|ID management|`18`|
|Policy control|`19`|
|Network based security|`19`|
|Security suites|`19`|
|The Observability Plane|`20`|
|Monitoring and Logging|`20`|
|Observability|`20`|
|FinOps|`21`|
|Incident Management|`22`|
|Golden paths|`23`|
|Golden path 1: Adding an S3 bucket to an<br>existing workload|`24`|
|Golden path 2: Fleet updating all S3<br>buckets in staging|`25`|
|Conclusion|`27`|



```
2REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

# Introduction 

standard reference architecture for When the first Internal Developer Platforms (IDPs) was published at PlatformCon back in June 2023, we couldn’t have anticipated how fast it would transform from blueprint to industry benchmark. Since its release, it has been downloaded more than 100,000 times, and has been regularly used by 100s of individuals and organizations to reason, plan, and implement their platform engineering initiatives. 

```
3
```

```
REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

As the Platform Engineering community has grown to over 270,000 members worldwide since the first release of these reference architectures, we’ve had the privilege of witnessing the full spectrum of platform initiatives from remarkable successes to instructive failures. At the same time, in this same period, we’ve also witnessed AI’s dramatic emergence and its profound impact on the Software Development Life Cycle (SDLC). This rapid influx of new data on platform engineering best practices, general industry maturity, and AI adoption has driven the creation of a new standard reference architecture for platform teams. 

It’s worth noting that these architectures represent practices from organizations that are both technically advanced and representative of typical enterprises. They come from teams ranging from hundreds to thousands of developers, operating in conventional business environments - not simply tech giants like Netflix, or Google. These reference architectures were shaped based on direct work across dozens of organisations, hundreds of conversations with practitioners, 

and direct data from 480 Internal Developer Platform examples shared by <u>Platform Engineering certifcation students, insights</u> from 90+ <u>platform engineering ambassadors, and data gathered</u> from almost hundreds of platform engineers via the <u>State of Platform Engineering survey.</u> 

For the average enterprise platform engineering team, adopting this architecture means investing in a proven approach that remains both financially accessible and practically implementable. 

This whitepaper provides value for two distinct audiences: experienced platform engineering practitioners seeking to understand what’s next (with particular emphasis on AI integration), and those embarking on their platform engineering journey and who want to get it right from the start. For newcomers to the field, we recommend first familiarizing yourself with the design fundamentals of <u>Internal Developer Platforms, and enroll</u> in a certifcation courses before exploring the advanced concepts presented here. 

```
4REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

# Overview _of_ changes in version 2.0 

While preserving the core architectural foundation, we are adding several strategic adjustments. What are the biggest updates to the reference architecture? 

```
5
```

```
REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

##### Multi-platform reality 

We now recognize that enterprises typically operate multiple platform types (up to four), rather than a single unified platform. At minimum, most organizations deploy separate Internal Developer Platforms (IDPs) for traditional backend and frontend services, data/AI workloads, and mobile application development. More sophisticated shops even differentiate between dedicated frontend and backend platforms, including specialized component libraries. This revised version focuses specifically on platforms supporting backend and frontend service development, whether in microservice-oriented or monolithic architectures. 

##### Code as truth, interface as enabler 

Developer interfaces and the control plane have become the primary access and interaction layer for most user groups. Best practices emphasize logging and versioning all changes as code, establishing Git as the single source of truth and complete system record. 

Beyond the IDE or CDE, we recommend offering a robust CLI and introducing conversational interfaces powered by AI, LLMs, co-pilots, and agents. This approach modernizes chat-ops, allowing users to query and modify components directly within their preferred chat environments. Our guiding principle remains to meet users where they already work embedding platform functionality seamlessly, without adding new interfaces. 

##### Central backend still rules 

Our guidance for the integration and delivery plane remains consistent. We continue recommending a central backend with graph-based metadata management and configuration rules enforcement. This central system functions as both endpoint and executor for interface-generated requests, driving standardization and automation throughout the environment. 

##### Security first 

Significantly more attention than previously is given to the security plane, as the domain is more commonly shifted down into the platform, reflecting both increasing platform complexity and emerging AI-related requirements. This critical infrastructure now spans the entire architecture, establishing the fundamental foundation upon which all other components are built. 

```
6REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

##### Roles and responsibilities 

We differentiate between those building the IDP and those consuming it, though these boundaries can sometimes blur. For instance, infrastructure platform engineers may simultaneously build platform capabilities while using those same tools to update underlying infrastructure. 

For clarity, we distinguish between platform owners and platform users. Typical platform users include backend developers, frontend developers, product and project managers, and executives in general. 

Platform owners, on the other hand, have long been referred to as “platform engineers”. But with the growing complexity and sophistication level of modern platforms, we are seeing specialization within the platform teams. As platform teams achieve this level of sophistication, specialized functions like security, cloud operations, and infrastructure increasingly assume dedicated platform engineering roles. 

This evolution requires strong alignment between the new specialized functions and the <u>core platform team, in order to maintain cohesion and</u> effectiveness across the platform ecosystem. 

- ŗ <u>Infrastructure platform engineers</u> are concerned with the resource plane, as well as part of the data plane and integration and delivery plane. 

- ŗ <u>DevEx platform engineers</u> primarily focus on interface design and user experience for platform consumers, while simultaneously managing onboarding processes, driving adoption initiatives and implementing measurement frameworks. 

- ŗ <u>Security platform engineers oversee the comprehensive security</u> plane, integrating protective measures throughout the IDP. They automate security controls, establish secure-by-default configurations, and implement compliant practices. 

- ŗ <u>Observability platform engineers</u> with a specific focus on the observability layer 

- ŗ Platform Product Managers for the coordination and <u>Head of Platform Engineering</u> for the leadership components. 

As we examine the various architectural planes, we’ll identify the responsible roles within the platform engineering team. For organizations without dedicated security platform engineers, these responsibilities would typically fall to your existing security team members. 

```
7REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

##### Design principles 

###### GitOps first 

We’ve opted for a GitOps first design, where every single edit action done in the platform is represented as a change in code. A full representation of the state of all systems (service, infra and tool configuration) is available as code in a versioned way. This approach ensures that any modification, whether initiated through user interfaces or automated agents acting on behalf of users, triggers a git pull request. Enforcing code-first changes guarantees disaster recovery and backup readiness, and is the ideal audit-log at scale. 

###### Backend first 

This has been a long and heated debate, but we strongly believe that a platform is only as good as its backend. The backend of a platform in the form of a Platform Orchestrator, or well-tuned pipelines, deals with the role and access management of your platform and stores a graph based representation of how all services and resources fit together, versioned by deployment. The backend should be designed API first and well documented. Think of the backend as the brain of your platform: if you don’t have this, and put everything in linear, on-off pipelines, you will accumulate tech debt fast. 

###### Secure by default 

Security is not an afterthought but a foundation. Every component, template, and workflow in the platform should enforce least-privilege access, encryption in transit and at rest, and secret retrieval, not distribution, by default. Public exposure is denied unless explicitly allowed, and all changes are validated through policy-as-code. This design minimizes configuration drift and human error, ensuring that developers can move fast without creating vulnerabilities. The platform’s defaults favor containment and auditable automation, meaning security is always on, not added later. When secure practices are built into every golden path, the safest way naturally becomes the easiest and most productive way. 

```
8REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

###### Observability by default 

Observability is built into the platform from the start, not added later. Every component emits metrics, logs, and traces by default, using standardized formats and centralized aggregation. This ensures complete visibility into system health, performance, and user impact at any point in time. SLOs are defined per product and platform capability, with automated alerts tied to measurable error budgets. The observability plane spans across all others, enabling rapid root cause analysis, proactive incident detection, and informed capacity planning. A platform designed this way turns telemetry into an operational feedback loop, continuously improving reliability and developer experience. 

###### AI-augmented 

AI-augmented platforms embed intelligence directly into developer workflows, transforming how users interact with the system. Copilots, LLMs, and agents assist within IDEs, CLIs, and portals to automate repetitive tasks such as writing configurations, debugging pipelines, and generating documentation. These tools analyze logs, deployments, and metrics to surface insights, predict issues, and recommend optimizations in real time. All AI-driven actions remain governed by the platform’s established controls through trusted interfaces like the CLI or orchestrator API, preserving auditability and security. The result is a platform that learns continuously, amplifies human capability, and accelerates software delivery with confidence. 

```
9REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

# Deep _dive_ 

We will now deep dive into every plane and explain the components and how they intersect in detail. We will later demonstrate how those planes fit together by tracing two exemplary flows through the reference architectures. 

```
10REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

###### `PLATFORM TOOLING LANDSCAPE` 





















###### `INTERNAL DEVELOPER PLATFORM ON AWS` 









```
11REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```







### The Developer Control Plane 

This plane focuses on two core aspects: first, the interfaces through which users interact with the platform, and second, the representation of every action as code within version control. 

Together, these ensure a seamless user experience and a complete, auditable record of all platform operations. The Developer Control Plane is primarily designed and maintained by the DevEx platform engineer, who is responsible for optimizing usability, standardizing workflows, and embedding platform functionality directly into developers’ existing environments. 



##### IDE and CDE 

The IDE, for example Visual Studio, IntelliJ IDEA or PyCharm and the Cloud Development Environment (CDE) together form the developer’s primary workspace. The IDE or editor provides the interface for writing, running, and debugging code, while the CDE supplies the underlying, pre-configured infrastructure that hosts or connects to these editors. This combination defines the core of the developer experience and the most natural integration point for platform capabilities such as CLIs, copilots, and automation agents. 

We recommend standardizing on a small set of IDEs or supported editors to reduce integration overhead and 

investing heavily in high-quality plugins and extensions. The goal is to make the in-editor experience seamless - every instance where a developer must leave their editor to perform a task represents a potential productivity loss. 

CDEs are especially valuable in security-sensitive or AI-heavy environments, as they enable consistent, centrally managed, and compliant development setups. By provisioning standardized environments on demand, CDEs reinforce reproducibility, accelerate onboarding, and simplify experimentation across teams. 

```
12REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

##### Portals 

Portals, often referred to as Internal Developer Portals (IDPs), act as the primary user interfaces for interacting with different layers of the Internal Developer Platform. They provide centralized access to platform capabilities, allowing 

users to discover, manage, and operate services through a unified experience. Core components typically include service catalogs, deployment dashboards, and resource management views that abstract away underlying complexity. 



This reference architecture uses Backstage, an open-source developer portal framework originally created by Spotify to streamline their internal developer experience by centralizing tools, services, and documentation. In September 2020, it was accepted into the Cloud Native Computing Foundation (CNCF) as a Sandbox project and advanced to Incubating status in March 2022, reflecting its growing adoption and maturity in the cloud-native ecosystem. 

An emerging trend is the convergence of IDPs with observability platforms, creating a single pane of glass that combines operational control with real-time insights. Solutions such as Datadog now integrate service catalogs directly, enabling developers to monitor service health, performance, and dependencies within the same interface. 

##### Copilot, LLM, agents 

Copilots integrated into the IDE can dramatically improve developer productivity and code quality. By offering context-aware code suggestions, intelligent autocompletion, and real-time feedback on errors or code smells, these AI-driven assistants streamline workflows and reduce cognitive load. 

When extending the use of LLMs beyond code assistance, particularly for conversational interfaces that trigger infrastructure or env changes, it is critical to adopt a CLIfirst approach. This ensures such actions are executed through trusted CLIs, maintaining a verifiable audit trail and enforcing role-based access controls. 

```
13REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```







Enterprises should also invest in developer education around prompt engineering and secure interaction patterns. By equipping teams with the skills to use AI tools effectively and responsibly, organizations can fully harness their benefits while minimizing security and compliance risks. 



This reference architecture uses Claude Code, an agentic coding assistant originally developed by Anthropic to accelerate software development by understanding your entire codebase and executing natural-language commands. Launched in early 2025, it supports terminal, IDE and multi-file workflows and is rapidly gaining adoption across engineering teams. 

### The Integration and Delivery Plane 

This plane focuses on the processes and systems that take the code from <mark>deve</mark> lopment to deployment. It ensur <mark>es that</mark> software change <mark>s are reliably an</mark> d efficiently delivered to the target environments. The Integration and Delivery Plane is primarily the responsibility of the Infrastructure Platform Engineer. 



```
14REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

##### Structuring your Version Control System (VCS) 

We recommend maintaining a clear separation between baseline configurations and service code. Baseline configurations include infrastructure and configuration templates, scaffolding blueprints, and platform settings. These should be centrally managed to ensure consistency, security, and compliance across the organization. 

Service code, by contrast, should define workloads through an abstract specification (for example, a Score file) that declares dependencies, resources, and environment variables. This approach enables true self-service 

by allowing developers to modify configurations safely within predefined boundaries. 

Infrastructure as Code (IaC) definitions, such as Terraform modules, should remain under the control of the central platform or operations team and only be adjusted when a specific, exceptional configuration is required. This separation of concerns preserves workflow integrity, supports automation, and balances standardization with the flexibility developers need to innovate effectively. 

##### CI pipeline 

The CI pipeline automates the building and testing of developed code. It compiles the code, runs automated tests, and upon successful completion, pushes the resulting container images to the image registry. It can also notify the Platform Orchestrator about new images and submit the Workload specification to trigger a deployment. 



This reference architecture uses GitHub Actions for CI. Since its introduction, GitHub Actions has rapidly become a top CI choice, especially for teams already on GitHub, due to its deep integration with repository events and a large marketplace of reusable actions. 

```
15REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

##### Image registry 

The image registry stores container images. It serves as a central repository for these images, making them accessible for deployment. The registry itself does not have a direct integration with the Platform Orchestrator but can have its credentials provided to CI/CD systems or workloads. 

##### Platform Orchestrator 

The Platform Orchestrator, in this case Humanitec, controls the general structure of your estate in the form of a graph. It knows which application connects to what resource in what environments and in which part of your estate. It also deals with central RBAC, checking which user is allowed to deploy to which part or apply which change. Finally it can orchestrate sign-off or security checks. It receives deployment metadata from the CI pipeline, including image paths, tags, and deployment deltas, and uses this information to trigger and manage deployments. It acts as the central control point for deploying and managing applications. 

##### CD system 

The CD system handles the actual deployment of applications. This can be the Platform Orchestrator’s deployment capabilities, an external system triggered by the Platform Orchestrator via pipelines, or a setup in tandem with GitOps operators like Flux or ArgoCD. It ensures that the latest code and configurations are deployed to the target environments. 

```
16REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```







### The Resource Plane 

This plane is primarily governed and developed by the Infrastructure Platform Engineering team. It <mark>encompasses se</mark> veral key categories: compute, which includes servers, virtual machines, and containers for processing workloads; networking, which manages the connectivity and communication between different components, including routing, firewalls, and load balancers; storage, which handles data persistence and retrieval, encompassing block storage, object storage, and file systems; and databases, which provide structured data management and access, including relational databases, NoSQL databases, and data warehouses. 









This reference architecture is for a Internal Developer Platform on AWS and uses EKS for compute, RDS MySQL, Route 53 and Amazon SQS. 

```
17REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```







### <mark>Secur</mark> it <u>ne</u> <mark>y Pla</mark> 

The Security Plane is primarily the responsibility of the Security <mark>Platfo</mark> rm Engineer. Its components are interwoven into different parts of the SDLC. 



##### Code analysis 

Code analysis involves scanning source code for vulnerabilities, security flaws, and compliance issues. This is integrated early in the SDLC, during the coding phase, and as part of the CI pipeline to ensure security is built in from the start. 



This reference architecture uses Sourcegraph, a codeintelligence platform that enables teams to search, understand and refactor large codebases by merging deep code-search, code navigation and AI-assistant capabilities. Founded in 2013, it has grown into a core tool for modern engineering orgs and now supports large-scale insights, batch changes and AI agents to industrialise software development. 

##### Secrets management 

Secrets management focuses on the secure storage and handling of sensitive information like API keys, passwords, and certificates. It is critical throughout the SDLC, from development to deployment, ensuring that secrets are never exposed in code or logs. 

##### ID management 

Identity (ID) management, or interchangeably Identity & Access Management (IAM), controls user access and authentication within the platform. It is crucial at every stage of the SDLC, ensuring that only authorized users can access and modify resources, and that actions are auditable. 

```
18REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

##### Policy control 

Policy control defines and enforces security policies across the platform. This includes defining access controls, compliance requirements, and operational guidelines. It affects all stages of the SDLC, ensuring that deployments and configurations adhere to security standards. 

##### Network based security 

Network-based security involves protecting the platform’s network infrastructure from unauthorized access and attacks. It includes firewalls, intrusion detection systems, and network segmentation. This is a continuous concern throughout the SDLC and runtime environment. 

##### Security suites 

Security suites integrate multiple security tools and services into a unified platform. These suites can include vulnerability scanners, intrusion detection systems, and security information and event management (SIEM) tools. They provide comprehensive security coverage and are relevant throughout the SDLC and operational phases. 



This reference architecture uses SentinelOne Singularity Platform, an AI-powered cybersecurity platform that unifies endpoint protection, detection & response (EPP/EDR), cloud workload and identity security into a single solution. Founded in 2013 and publicly listed in 2021, it leverages behavioural machine learning to detect threats and automatically remediate compromised systems, reflecting its leadership in the modern cyber-defence landscape. 

```
19REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```







### The Observability Plane 

The Observability plane provides a comprehensive view into the health and performance of the platform and its applications. It encompasses monitoring, logging, tracing, and alerting capabilities, enabling teams to understand the state of the system in real-time and diagnose issues effectively. The Observability Platform Engineer is primarily responsible for designing, implementing, and maintaining the Observability Plane, ensuring that it provides actionable insights and supports the overall reliability and stability of the platform. 



##### <mark>n</mark> Monitoring a d Logging 

<mark>Monitori</mark> ng involves collecting and analyzing metrics related to system performance, resource utilization, and application behavior. This includes trackin <mark>g</mark> key per <mark>forman</mark> ce indicators (KPIs) and setting up alerts for anomalies or thresholds. Logging captures detailed records of events and activities within the platform, providing a historical context for troubleshooting and auditing. Both monitoring and logging are crucial for identifying and resolvin <mark>g</mark> issues <mark>p</mark> rom <mark>p</mark> tly, as well as for understanding trends and patterns in system usage. 

##### Observability 

Observability focuses on the health and performance of the underlying infrastructure components, such as servers, networks, and storage systems. It involves collecting metrics and logs from these components to gain insights into their utilization, availability, and potential bottlenecks. This allows platform teams to ensure that the infrastructure can support the demands of the applications running on it and proactively address any issues before they impact users. 

```
20REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```



This reference architecture uses Datadog, the most popular and widely used observability suite. Datadog is an observability platform that unifies metrics, traces, logs, and user-experience data across infrastructure and applications. Originally launched in 2010, and providing over 1,000 built-in integrations covering cloud services, containers, databases, and security tools. 

##### FinOps 

Finops approaches like cost tracking and chargebacks involve monitoring the expenses associated with running the platform and its applications, and allocating these costs to the respective teams or departments. This includes tracking resource usage, cloud provider bills, and other expenses. By providing visibility into costs, teams can optimize resource utilization, identify cost-saving opportunities, and ensure that expenses are aligned with business priorities. Chargebacks can be used to hold teams accountable for their resource consumption and encourage efficient usage. 



This reference architecture uses Kubecost, an open-source cost monitoring and optimization platform for Kubernetes environments. Developed by ex-Google engineers in 2019, it provides real-time visibility into cluster spending and resource efficiency by mapping usage of CPU, memory, GPU, and storage to actual cloud costs. By integrating with major cloud providers and FinOps tools, Kubecost enables platform teams to allocate costs accurately across namespaces, deployments, or teams, supporting effective showback, identifying expensive or overprovisioned workloads, and improving overall operational efficiency in multi-tenant Kubernetes clusters. 

```
21REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

##### Incident Management 

Incident Management is the process of responding to and resolving incidents that disrupt the platform or its applications. It involves detecting, diagnosing, and remediating issues, as well as communicating with stakeholders and documenting the incident. The Observability Plane plays a crucial role in Incident Management by providing the data and tools needed to understand the impact of an incident, identify the root cause, and track the progress of resolution. Effective Incident Management ensures minimal downtime and disruption to users. 

```
22REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

# Golden _paths_ 

Golden paths are standardized, opinionated workflows that guide developers through common tasks in a consistent, safe, and efficient way; essentially “paved roads” that remove ambiguity while preserving flexibility. Within the context of platform engineering, golden paths represent the bridge between developer experience and organizational best practices: they ensure that teams can deliver quickly while staying compliant and secure. As demonstrated in our Platform Engineering Certification courses these paths help platform teams codify complex workflows into repeatable, self-service experiences, turning what used to be tribal knowledge into accessible, automated processes. The following examples illustrate how golden paths manifest in practice, from provisioning new resources to orchestrating fleet-wide infrastructure updates. 

```
23REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

### Golden path 1: Adding an S3 bucket to an existing workload 

A developer, aiming to enhance their application’s functionality, identifies the need for an S3 bucket to manage object storage. Leveraging the platform’s intuitive LLM-powered chat interface, they express their intent in natural language. The LLM, trained on the platform’s intricacies, seamlessly translates this request into a precise CLI command, which in turn initiates a GitOps workflow. 

A pull request is automatically generated, targeting the `score.yaml` file that defines the application’s resource requirements. The PR introduces a new resource block under the relevant service, specifying the S3 bucket’s type and a desired name: 

```
# ... (previous content)
resources:
  - type: s3
    name: my-data-bucket
```

Upon approval and merge, the change triggers the CI/CD pipeline. The pipeline orchestrates the build process, compiling the application code into a container image. This image then undergoes rigorous code analysis within the security plane, scanning for potential vulnerabilities and ensuring compliance with established security policies. Once deemed secure, the image is pushed to the container registry. 

The orchestrator, now aware of the updated image and its resource requirements, analyzes the metadata and application context. It determines that the new resource request necessitates 

the provisioning of an S3 bucket and identifies the appropriate infrastructure template to achieve this. However, before proceeding, the orchestrator consults the ID management system to verify that the developer possesses the necessary permissions to create and manage S3 buckets. 

A sign-off process is initiated, potentially involving additional approvals from senior team members or security personnel. If required, further security checks are performed to assess the potential impact of the new resource on the overall system. Upon successful completion of 

```
24REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

these checks, the orchestrator executes the Infrastructure as Code (IaC) defined within the chosen template. This IaC interacts with the cloud provider’s API, dynamically provisioning the S3 bucket with the specified name and appropriate configuration. The secret manager, integrated into the platform, securely retrieves the newly created bucket’s access credentials and injects them as secrets into the application’s container environment. This ensures that the application can seamlessly interact with the S3 bucket without exposing sensitive information. Finally, the orchestrator confirms the successful provisioning of the 

S3 bucket to the developer. 

Simultaneously, the infrastructure observability suite springs into action, integrating the new S3 bucket into its monitoring and visualization framework. The bucket becomes a node within the platform’s comprehensive resource graph, allowing for real-time monitoring of its performance and health. Additionally, the bucket’s endpoint is made accessible through the platform’s portal, providing the developer with a convenient interface to manage its contents and integrate it into their application’s workflow. 

### Golden path 2: Fleet updating all S3 buckets in staging 

This example demonstrates how platform engineers can safely update infrastructure using standardized workflows. Each stage from initial code changes and automated policy validation to simulation, progressive rollout, and real-time observability shows how the platform enforces control, transparency, and reliability throughout the entire delivery process. 

_01_ The IDE and policy engine `STEP` 

The platform engineer initiates the process within their IDE, which is seamlessly integrated with the platform’s IaC tooling. As the engineer modifies the S3 bucket template, the policy engine, operating in the background, dynamically analyzes the changes. This real-time analysis ensures that the proposed modifications adhere to the organization’s security policies, compliance standards, and best practices. Any potential misconfigurations or violations are immediately flagged, preventing the introduction of errors or vulnerabilities into the infrastructure. 

```
25REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

The platform, portal, and simulation 

_02_ `STEP` 

Platform orchestration and progressive rollout 

_03_ `STEP` 

_04_ Observability and monitoring `STEP` 

With the template changes validated, the engineer turns to the platform portal. This centralized dashboard provides a comprehensive view of the S3 bucket landscape. The engineer can visualize all active buckets, their version history, and their deployment across various environments (development, staging, production). To mitigate risk, the engineer leverages the portal’s simulation capabilities. A simulation is executed, modeling the impact of the proposed changes on the existing environment variables and configurations. This predictive analysis helps identify potential conflicts or disruptions before the changes are applied. 

The actual deployment of the S3 bucket updates is managed by the platform’s Platform Orchestrator. This system automates the rollout process, adhering to a progressive delivery strategy. Initially, the changes are applied to a small subset of the development S3 buckets. This allows for early testing and validation in a controlled environment. If no issues are detected, the rollout gradually expands to a larger percentage of development buckets, and then progresses to the staging environment. This incremental approach minimizes the blast radius of potential failures and allows for rapid rollback if necessary. 

Throughout the entire rollout process, the observability plane plays a crucial role. Metrics and logs from the S3 buckets are continuously collected and analyzed. The observability plane provides real-time insights into the health and performance of the updated infrastructure. Any anomalies or unexpected behaviors are immediately detected and alerted upon. The platform portal displays a live view of the rollout’s progress, including the updated S3 bucket versions across all environments. This transparency enables the engineer to track the impact of the changes and make informed decisions. 

```
26REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

# Conclusion 

The evolution from the first to the second reference architecture marks a decisive step in the maturity of platform engineering. The 2023 release established a shared vocabulary and mental model for Internal Developer Platforms, while version 2.0 reflects how the discipline has evolved through real-world adoption, the rise of AI-driven development, and the growing complexity of enterprise ecosystems. This new architecture captures not just what teams are building, but how they operate at scale, how they secure their environments by default, and how they use observability and automation to achieve predictable, measurable outcomes. 

```
27
```

```
REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

The principles underpinning this architecture emphasize that effective platforms are not collections of tools, but cohesive systems built on clarity, consistency, and control. By codifying every action, defining a single source of truth, and embedding security and observability, enterprises can reduce cognitive load, accelerate delivery, and minimize risk. 

Equally important, this version recognizes that no two platforms are alike. The multi-platform reality acknowledges that modern organizations often operate several internal platforms, spanning frontend and backend services, data and AI workloads, and mobile applications. Yet across these diverse implementations, the same architectural fundamentals apply: clear ownership, composability, automation, and continuous feedback loops. 

However, it is crucial to takeaway that this updated reference architecture is not a prescription but a framework. It enables teams to design platforms that fit their context while remaining grounded in proven best practices. Whether 

an organization is just beginning its platform journey or refining a mature setup, these patterns provide the foundation for sustainable platform engineering. 

By learning from thousands of practitioners and hundreds of implementations, this version ensures that as technology, AI, and organizational structures evolve, platform engineering continues to serve its core purpose: empowering teams to build, ship, and operate software faster, more securely, and with greater confidence than ever before. 

Simultaneously, the infrastructure observability suite springs into action, integrating the new S3 bucket into its monitoring and visualization framework. The bucket becomes a node within the platform’s comprehensive resource graph, allowing for real-time monitoring of its performance and health. Additionally, the bucket’s endpoint is made accessible through the platform’s portal, providing the developer with a convenient interface to manage its contents and integrate it into their application’s workflow. 

```
28REFERENCE ARCHITECTURE OF AN INTERNAL DEVELOPER PLATFORM ON AWS
```

