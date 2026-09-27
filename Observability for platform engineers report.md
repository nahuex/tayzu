##### Weave Intelligence 

# Observability  for platform engineers 

WEAV <mark>E</mark> IN <mark>T</mark> ELLI <mark>G</mark> ENCE PRES <mark>E</mark> NTS Observability for platform engineers FIRS <mark>T</mark> PU <mark>B</mark> LISH <mark>E</mark> D IN 2025 

02 Observability for platform engineers 



## The strategic role 

The rapid evolution toward distributed systems, microservices, and complex cloud-native environments has 

fundamentally broken traditional monitoring paradigms. Today’s platforms consist of layers of wellmeaning but leaky abstractions, introducing an exponential amount of complexity and moving parts that make reliable operation difficult. For CTOs, Platform Engineers, and DevEx leaders, the challenge is clear: an unobservable platform guarantees poor user experience, wasted engineering time, and constant guessing during incidents. 

This complexity mandates a strategic shift from mere monitoring, the practice of collecting telemetry to genuine observability. As a companion piece to the Platform Engineering University course, Observability for Platform Engineers, this report will break down exactly what observability is, why it matters for platform engineers, and what we can do to prepare ourselves for the future. 

To start, observability is simply a property of the system: the ability to reliably determine any internal state by asking questions from the outside. If monitoring tells us something is wrong, observability provides the essential context required to understand why it is broken, diagnose incidents, and validate deployments. It is the indispensable foundation for building trust and high confidence in modern systems. 

Platform engineering organizations must strategically address this challenge by treating observability not as an afterthought or a collection of siloed tools, but as a key platform capability. Platform teams bear the dual responsibility of observing their own infrastructure (Kubernetes, CI/ CD, shared services) and enabling application developers to observe their own applications efficiently. Success requires abstracting away complexity and providing a "paved path to visibility". 



Platform engineering organizations must strategically addres ~~s~~ this challenge by treating observability not as an ~~a~~ fterthought or a collection of siloed tools, but as a key ~~<u>pla</u>~~ tfor ~~m~~ capability. 

03 Observability for platform engineers 



This is achieved through aggressive automation and rigorous adherence to open standards. The adoption of OpenTelemetry (OTel), the vendor-neutral standard for collecting and structuring telemetry data, is a crucial part of this. OTel provides the unified APIs, semantic conventions, and standardized protocols necessary to ensure consistent, correlated data (logs, metrics, traces) across all teams and environments. By leveraging tools like the OpenTelemetry Operator to enable auto-instrumentation, platform teams remove manual toil, enforce telemetry hygiene, and allow developers to focus on core business logic while receiving insights by default. 

The future is clear. Observability is not an isolated domain. It is a core part of the platform engineering puzzle and should be treated as such. Investing in a structured, standards-based observability platform is a strategic decision that future-proofs your infrastructure and your organization. Observability is no longer a cost center; when integrated correctly, it becomes a “capability multiplier for scaling the engineering organization, dramatically improving platform reliability, accelerating incident resolution, and maximizing developer productivity. 

|Key take-aways from|this report|
|---|---|
|01<br>Observability is strategic,<br>not just monitoring|Modern distributed systems demand more than alerts.<br>Observability explains why issues happen, not just that<br>something is wrong, enabling faster, confdent<br>resolution.|
|02<br>Platform engineers have<br>a dual mandate|They must maintain operational visibility of shared<br>infrastructure while empowering developers with<br>effortless, consistent telemetry to reduce friction<br>and rework|
|03<br>Standards and<br>automation unlock scale|Manual instrumentation fails at scale. Enforcing<br>semantic conventions and automating data collection<br>with OpenTelemetry ensures reliable, high-quality<br>insights across teams.|
|04<br>Treat observability as a<br>platform product|Embed it as a self-service capability with paved paths,<br>golden defaults, and clear guardrails. This future-proofs<br>infrastructure and maximizes developer productivity.|



04 Observability for platform engineers 



## What is Observability? 

As we navigate increasingly complex, distributed, and cloud-native systems, the distinction between monitoring and observability is increasingly misunderstood. Observability is the ability to reliably determine any internal state of a system simply by asking questions from the outside. It is the state of understanding. Monitoring, conversely, is the practical act of collecting and processing the telemetry data (or signals) necessary to attain that property. While monitoring is essential for alerting engineers of issues, observability provides the context necessary to explain precisely why something might be broken and allows teams to 

form and test hypotheses rapidly to resolve the issue. 

Traditional monitoring has proven ever more insufficient as layers upon layers of well-meaning, but leaky, abstractions are added to modern infrastructure, particularly with the rise of microservices and complex Kubernetes environments. This complexity introduces countless moving parts and failure modes that demand more than simple health checks; they require actual insights to ensure system health and build confidence in pushing changes to production. 

#### Evolving beyond the three pillars 



Historically, observability discussions revolved around the “three pillars”: logs, metrics, and traces. While these types of telemetry remain core, the metaphor of pillars did not age well, as it fails to convey the importance of <u>having these data types seamlessly</u> correlated with one another. Modern 

~~obs~~ ervabil ~~i~~ ty treats them not as standalone silos, but as ~~inte~~ rc ~~onne~~ ct ~~ed~~ si ~~g~~ nals that ~~<u>c</u>~~ ol ~~lec~~ <u>t</u> ~~<u>ive</u>~~ ly form a complete narrative of ~~s~~ yste ~~m~~ behaviour. 

Each signal serves a specific purpose in this narrative: Metrics are effective time series used for identifying trends, tracking key indicators (like latency or error rate), and driving alerts. Logs provide detailed, temporal records of events, crucial for forensic analysis and error context. Traces (composed of spans) track the full journey of a single user request across multiple services, highlighting timing, dependencies, and bottlenecks in distributed architectures. 

05 Observability for platform engineers 



Furthermore, this converged view integrates signals like production profiles (revealing what code is consuming CPU or memory at runtime) and Real User Monitoring (RUM), which captures end-user experience directly from the browser or mobile application. 

#### The importance of context and quality 

### 70% 



The convergence of these signals is meaningless, however, if the underlying data lacks coherence. Telemetry without context is just data (or noise). When telemetry is confusing, engineers often draw hasty and wrong conclusions, exacerbating incident response times. 

To evaluate telemetry quality, leaders must ensure their data addresses four key areas: Semantics (What does the data represent, and is it clearly defined), Context (Does it capture where and under what conditions it was generated, such as the service version or cloud region), Relations (Is it linked to related signals, like a log pointing to a trace), and Accuracy (Is the data correct and reliable). 

To transform raw data into insights we can actually act on, telemetry must be intentionally designed to be highquality and trustworthy. 

This emphasis on quality necessitates moving away from merely instrumenting everything toward designing telemetry that answers specific questions about system failure modes. 

of platform teams cite “data noise and lack of context” as the main cause of prolonged outages. 

To be able to use telemetry effectively to achieve the observability of a platform, you really need to understand it. You need to know what that telemetry represents. You need to know from which system it is coming from. You need to know how different pieces of telemetry are related with each other. 

Michele Mancioppi Head of Product, Founding Engineer @ Dash0 

06 Observability for platform engineers 



#### Standardization through Semantic Conventions 



Achieving context at scale across dozens or hundreds of services requires standardization. This is where Semantic Conventions become foundational. These conventions, driven primarily by the OpenTelemetry (OTel) standard, define the common vocabulary for telemetry, naming rules for traces, logs, and metrics. Without them, teams invent conflicting labels, leading to broken queries and useless dashboards. With these standards, telemetry becomes portable, composable, and reusable across different teams and tools. 

These attributes are essential for grouping, filtering, and joining telemetry meaningfully, especially in multi-tenant or multi-cluster environments. 

Another "superpower" of modern observability is Cross-Signal Correlation. By linking metrics, logs, and traces using shared resource attributes and trace context propagation, operators can fluently navigate from a high-level metrics alert to a specific trace showing the slow path, and then to the correlated log lines detailing the error. This capability dramatically reduces Mean Time to Resolution (MTTR) and improves overall system confidence. 

Crucially, OpenTelemetry allows the use of Resource Attributes (metadata like service.name, cloud.region, or k8s.pod.name) across all signals (logs, metrics, and traces). 

Teams using standardized telemetry see up to 44% faster incident resolution by eliminating conflicting labels and enabling seamless signal correlation. 

As platform complexity increases, managing the entire lifecycle of telemetry, from intentional collection and rigorous standardization to reliable correlation, becomes the non-negotiable responsibility of the platform engineering team. This is the strategic layer that ensures developers receive visibility by default and the platform remains robust. 

07 Observability for platform engineers Why observability matters for platform engineers 

For platform engineers, observability is not merely monitoring with a new name; it is fundamental to success in delivering a functional and satisfying platform experience. 

Because platform teams are responsible for managing the increasing levels of complexity underpinning applications, observability is mission-critical for detecting and troubleshooting issues fast, ensuring fixes are effective, and ultimately helping developers deliver a good user experience to their own users. Platform engineers operate with two distinct, but interconnected, responsibilities 

regarding system visibility. First, they must meticulously observe the health of the platform infrastructure itself, including Kubernetes clusters, cloud resources, databases, message brokers, and CI/CD pipelines. 

This platform observability involves tracking resource usage, errors, and interactions across services and tenants to build confidence that changes can be pushed to production safely. Second, the platform team must act as a provider, effectively enabling developers by building "observability as a service" for application teams. 



08 Observability for platform engineers 





###### Reducing developer toil 

The future is clear. Observability is not an isolated domain. It is a core part of the platform engineering puzzle and should be treated as such. Investing in a structured, standards-based observability platform is a strategic decision that future-proofs your infrastructure and your organization. 

Observability is no longer a cost center; when integrated correctly, it becomes a “capability multiplier” for scaling the engineering organization, dramatically improving platform reliability, accelerating incident resolution, and maximizing developer productivity. 

Shifting observability down into the platform makes visibility effortless and consistent. By baking in standards, automation, and context, teams cut manual setup, reduce tool drift, and speed root-cause analysis. 

63% 

71% 

2.6x 

of organizations plan to increase Observability investment over the next 2 years 

of organizations use OpenTelemetry or Prometheus in some form 

average ROI from observability spending, via improved developer productivity and operational efficiency 







09 Observability for platform engineers 





###### Correlation as a superpower 

The strategic value of platform-managed observability lies in its ability to seamlessly connect different telemetry signals. When logs, metrics, and traces are reliably tied together via shared resource attributes and trace context, operators gain the superpower to move fluently between them during an incident. 

For example, platform teams can navigate instantly from a latency spike identified in a metric alert to a specific trace showing a slow downstream service, and then to correlated logs that reveal the deployment change responsible. This cross-signal fluency dramatically reduces Mean Time to Resolution (MTTR) and builds overall system confidence and operational reliability. 

By embracing the mindset of Observability as a Product, a core feature designed with care for internal developer platform customers, platform engineers deliver self-service telemetry, guardrails for compliance, and standardized collection. This foundational capability directly shapes the developer experience and ensures operational reliability, which sets the stage for defining the practical standards and best practices that scale this new way of thinking. 



10 Observability for platform engineers 



## Insights & best practices 

Successfully implementing an observability strategy requires platform engineering teams to shift their focus from simply selecting tools to aggressively operationalizing standards and automation. Manual instrumentation and ad-hoc practices do not scale; they lead to gaps in 

coverage, noisy data, duplicate efforts, and increased toil for developers. By treating observability as a product capability baked into the infrastructure with clear defaults, platform engineers ensure that visibility is consistent, reliable, and effortless for internal customers. The goal is to remove repetitive, manual work (toil) by 

enforcing telemetry conventions and standards through automated processes. 

OpenTelemetry is key to enabling this. Its unified APIs and semantic conventions create a single, vendorneutral way to collect and structure logs, metrics, and traces. The OpenTelemetry Collector centralizes control, letting platform teams shape, route, and enrich data without touching application code. This standardization and automation make observability scalable, cost-effective, and easy to evolve as the platform grows. 

OpenTelemetry is the go-to standard for collecting data about how applications and platforms work 



11 Observability for platform engineers 













###### five practical insights you should prioritize 

###### Automate instrumentation at scale 

Modern distributed systems demand more than alerts. Observability explains why issues happen, not just that something is wrong, enabling faster, confident resolution. Modern distributed systems demand more than alerts. Observability explains why issues happen, not just that something is wrong, enabling faster, confident resolution. 

###### Standardize Telemetry with OpenTelemetry 

High-quality telemetry requires consistency and meaning. Semantic Conventions, standardized by the OpenTelemetry project, define a common vocabulary for logs, metrics, and traces (e.g., service.name, http.response.status_code). Without shared conventions, custom labels, and mismatched field names, broken queries and brittle dashboards are certain. Platform engineers must define and enforce these standards, making telemetry portable, queryable, and reusable across all services. 

###### Centralize control with the OTel Collector 

The OpenTelemetry Collector is the platform’s telemetry router and policy engine. It receives, processes, and routes data to chosen destinations. From this central point, platform engineers can cut costs by sampling high-volume traces, enforce compliance by redacting sensitive fields, or drop debug logs without changing application code. 

###### Implement GitOps for configurations 

Dashboards and alerts should be treated as code for consistency and easy recovery. With tools like Perses, teams can define dashboards in YAML, version them in Git, and deploy via CI/CD. This Dashboards-as-Code approach removes manual UI edits, enables review through pull requests, and keeps dashboards portable across tools. The same you should be doing with alert rules. 

###### Prov v ide pa ed paths and smart defaults 

Platform teams should build opinionated golden paths that deliver value fast: autoinstrumentation, standard dashboards, and pre-set alerts and sampling. The goal is to give developers a head start, not restrict them. Observability should work out of the box with guardrails for compliance, yet allow teams to adjust defaults as needed. 

12 Observability for platform engineers 



## Conclusion: Observability is a force multiplier 

Our industry is facing a strategic evolution from traditional monitoring to modern observability, establishing it as the fundamental property in navigating today’s complex, distributed systems. For platform engineers, observability is defined by a dual mandate: maintaining operational visibility of critical infrastructure while actively enabling developers with consistent, high-quality telemetry (logs, metrics, and traces). The strategic challenge is beyond tools, to the operationalization of observability. 

The path forward is defined by adopting a Platform as a Product mindset, viewing observability not as a checklist or a separate system, but as a core, self-service feature designed for internal users. This requires platform teams to aggressively implement automation, primarily through the OpenTelemetry standard, to enforce 

semantic conventions, ensure data consistency, and create "paved paths to visibility". 

The call to action is clear: investment and focus on standardized, automated observability is a key lever in advancing your organization towards the future. This approach reduces duplication, eliminates vendor lock-in, and ensures logs, metrics, and traces are reliably correlated - the superpower for resolving incidents quicker and building incredible system confidence. By embedding these practices down into the platform now, your Internal Developer Platform becomes more adaptable, futureproofing infrastructure, reducing technical toil, and shifting 

observability from a cost centre to a force multiplier. 

The math couldn’t be easier. 



###### Observability for Platform Engineers 

This report is a companion piece for the 5 module Observability course on Platform Engineering University 

Register now Registe 

