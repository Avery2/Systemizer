import { IDataOperator, ShowStatusCodeEvent } from "src/interfaces/IDataOperator";
import { Connection } from "./Connection";
import { RequestData, RequestDataHeader } from "./RequestData";
import { Port } from "./Port";
import { EventDispatcher, Handler } from "./Shared/EventDispatcher";
import { arrayEquals, sleep, UUID } from "src/shared/ExtensionMethods";
import { Endpoint, EndpointRef } from "./Endpoint";
import { EndpointOperator, EndpointOptions } from "./EdpointOperator";
import { Protocol } from "./enums/Protocol";
import { EndpointActionHTTPMethod, HTTPMethod } from "./enums/HTTPMethod";
import { HTTPStatus } from "./enums/HTTPStatus";
import { APIType } from "./enums/APIType";
import { gRPCMode } from "./enums/gRPCMode";

interface ReceiveDataEvent { }

export class APIGateway extends EndpointOperator implements IDataOperator{

    inputPort: Port;
    connectionTable: {[id:string]:Connection} = {};
    options: APIGatewayOptions;
    originID: string;

    constructor() {
        super()
        this.inputPort = new Port(this, false, true);        
        this.outputPort = new Port(this, true, true);       
        this.options = new APIGatewayOptions(); 
        this.options.title = "API Gateway";
        this.originID = UUID();
    }

    async receiveData(data: RequestData, fromOutput:boolean) {
        if(fromOutput){
            let targetConnection = this.connectionTable[data.responseId]
            if(targetConnection == null) // connection could be ended before last data was sent
                return; 
            // Checking if endpoint wasn't removed before stream end
            this.fireReceiveData(data);
            if(data.header.stream){
                let hasAction = false;

                this.getEndpoints().forEach(endpoint => {
                    endpoint.actions.forEach(action => {
                        if(action.endpoint.url === data.header.endpoint.endpoint.url &&
                        arrayEquals(action.endpoint.supportedMethods, data.header.endpoint.endpoint.supportedMethods)){
                            hasAction = true;
                        }
                    })
                })
                if(!hasAction){ // send end of stream to out if the action no longer exists
                    data.header.stream = false;
                    data.requestId = data.responseId;
                    data.responseId = null;
                    let result = this.outputPort.sendData(data,data.origin)
                    if(result)
                        this.connectionTable[data.responseId] = null;
                    return;
                }
                let result = await this.inputPort.sendData(data, this.connectionTable[data.responseId]);
                if(!result && data.header.stream){ // send end stream to out if the client doesnt exist 
                    data.header.stream = false;
                    data.requestId = data.responseId;
                    data.responseId = null;
                    let res = this.outputPort.sendData(data,data.origin)
                    if(res)
                        this.connectionTable[data.responseId] = null;
                }
            }
            else{
                if(data.header.endpoint.endpoint.protocol == Protocol.WebSockets || data.header.endpoint.endpoint.grpcMode == gRPCMode["Bidirectional Streaming"] || data.header.endpoint.endpoint.grpcMode == gRPCMode["Server Streaming"])
                    await this.inputPort.sendData(data, this.connectionTable[data.responseId]);
            }
        }
        else{
            if(data.requestId == "" || data.requestId == null) throw new Error("Request ID can not be null");
            if(data.header.endpoint == null) throw new Error("Endpoint can not be null")

            // Checking for 404 and 405
            let hasEndpoint = false;
            let notAllowed = false;
            let targetEndpoint: Endpoint;
            let targetUrl = data.header.endpoint.endpoint.url;

            this.getEndpoints().filter(endpoint => 
                endpoint.url == targetUrl
            ).forEach(endpoint => {
                hasEndpoint = true;
                if(endpoint.supportedMethods.indexOf(data.header.endpoint.method) == -1){
                    notAllowed = true;
                }
                else{
                    // Found wanted endpoint
                    notAllowed = false;
                    targetEndpoint = endpoint;
                    return;
                }
            })

            if(!hasEndpoint){
                this.fireShowStatusCode(HTTPStatus["Not Found"])
                return;
            }
            if(notAllowed){
                this.fireShowStatusCode(HTTPStatus["Method Not Allowed"]);
                return;
            }

            this.fireReceiveData(data);
            let sendResponse = false;
            let isFirstStreamRequest = this.connectionTable[data.requestId] == null && data.header.stream;
            let isLastStreamRequest = this.connectionTable[data.requestId] != null && !data.header.stream;
            let dontSendRequestResponse = (isFirstStreamRequest || isLastStreamRequest);

            // Send data to every action 
            for(let action of targetEndpoint.actions){
                // Get connection to given action endpoint
                if(action.endpoint == null || action.endpoint.url == null)
                    continue;
                let targetConnection: Connection;
                for(let connection of this.outputPort.connections){
                    let endpoints = connection.getOtherPort(this.outputPort).parent.getAvailableEndpoints();
                    if(endpoints.find(endpoint => endpoint.url == action.endpoint.url && arrayEquals(endpoint.supportedMethods,action.endpoint.supportedMethods)) != null ){
                        targetConnection = connection;
                        break;
                    }
                }
                if(targetConnection == null)
                    continue;

                let isStream = action.endpoint.protocol == Protocol.WebSockets || action.endpoint.grpcMode != gRPCMode.Unary;
                if(data.header.stream && isStream && action.endpoint.grpcMode == gRPCMode["Server Streaming"] 
                && !dontSendRequestResponse || dontSendRequestResponse && !isStream) {
                    continue;
                }

                let requestId = (isStream && !data.header.stream && !isLastStreamRequest) ? UUID() : data.requestId;
                this.connectionTable[requestId] = data.origin;
                let request = new RequestData();
                let epRef = new EndpointRef();
                epRef.endpoint = action.endpoint;
                epRef.method = EndpointActionHTTPMethod[action.method] == "Inherit" ? data.header.endpoint.method : HTTPMethod[EndpointActionHTTPMethod[action.method]]
                
                request.header = new RequestDataHeader(epRef, action.endpoint.protocol, data.header.stream);

                request.origin = targetConnection;
                request.originID = this.originID;
                request.requestId = requestId;

                if(isStream)
                    this.outputPort.sendData(request, targetConnection);
                else{
                    if(!data.header.stream) 
                        sendResponse = true;
                    await this.outputPort.sendData(request, targetConnection);
                }
            }

            if(isFirstStreamRequest)
                this.connectionTable[data.requestId] = data.origin;
            if(targetEndpoint.grpcMode == gRPCMode["Server Streaming"]) {
                if(isFirstStreamRequest){
                    // Initiate server stream 
                    let response = new RequestData();
                    response.header = new RequestDataHeader(data.header.endpoint, targetEndpoint.protocol, data.header.stream);
                    response.origin = data.origin;
                    response.originID = this.originID;
                    response.requestId = UUID();
                    response.responseId = data.requestId;
                    this.serverStream(response, targetEndpoint);
                }
                if(isLastStreamRequest)
                    this.connectionTable[data.requestId] = null;
            }
            if(sendResponse){
                // Send response back
                this.connectionTable[data.requestId] = data.origin;
                let response = new RequestData();
                response.header = new RequestDataHeader(data.header.endpoint, targetEndpoint.protocol, data.header.stream);
                response.origin = data.origin;
                response.originID = this.originID;
                response.requestId = UUID();
                response.responseId = data.requestId;
                await this.sendData(response);
            }
        }
    }

    onConnectionUpdate(wasOutput: boolean = false){}

    async sendData(response: RequestData) {
        let targetConnection = this.connectionTable[response.responseId]
        if(targetConnection == null)
            return;
        let result = await this.inputPort.sendData(response, targetConnection);
        if(!result && response.header.stream){
            response.header.stream = false;
            response.requestId = response.responseId;
            response.responseId = null;
            let res = this.outputPort.sendData(response,response.origin)
            if(res){
                this.connectionTable[response.responseId] = null;
            }
        }
    }

    async serverStream(data: RequestData, streamingEndpoint: Endpoint){
        await sleep(700);
        if(streamingEndpoint.actions.length == 0 || this.connectionTable[data.responseId] == null || (
            streamingEndpoint.grpcMode != gRPCMode["Server Streaming"]) ||
            this.getEndpoints().indexOf(streamingEndpoint) == -1) return;

        for(let action of streamingEndpoint.actions){
            // Get connection to given action endpoint
            if(action.endpoint == null || action.endpoint.url == null || action.endpoint.grpcMode != gRPCMode.Unary || action.endpoint.protocol == Protocol.WebSockets)
                continue;

            let targetConnection: Connection;
            for(let connection of this.outputPort.connections){
                let endpoints = connection.getOtherPort(this.outputPort).parent.getAvailableEndpoints();
                if(endpoints.find(endpoint => endpoint.url == action.endpoint.url && arrayEquals(endpoint.supportedMethods,action.endpoint.supportedMethods)) != null ){
                    targetConnection = connection;
                    break;
                }
            }
            if(targetConnection == null)
                continue;

            let newReqId = UUID();
            this.connectionTable[newReqId] = data.origin
            let request = new RequestData();
            let epRef = new EndpointRef();
            epRef.endpoint = action.endpoint;
            epRef.method = EndpointActionHTTPMethod[action.method] == "Inherit" ? data.header.endpoint.method : HTTPMethod[EndpointActionHTTPMethod[action.method]]

            request.header = new RequestDataHeader(epRef, action.endpoint.protocol);
            request.origin = targetConnection;
            request.originID = this.originID;
            request.requestId = newReqId;
            await this.outputPort.sendData(request, targetConnection);
        }

        await this.sendData(data);
        await this.serverStream(data, streamingEndpoint);
    }

    connectTo(operator: IDataOperator, connectingWithOutput:boolean, connectingToOutput:boolean): Connection{
        if(connectingWithOutput)
            return this.outputPort.connectTo(operator.getPort(connectingToOutput));
        return this.inputPort.connectTo(operator.getPort(connectingToOutput));
    }

    getPort(outputPort:boolean=false): Port {
        if(outputPort)
            return this.outputPort;
        return this.inputPort;
    }

    getAvailableEndpoints(): Endpoint[]{
        return this.getEndpoints();
    }

    getEndpoints() : Endpoint[]{
        return this.options.restEndpoints
            .concat(this.options.rpcEndpoints)
            .concat(this.options.grpcEndpoints)
            .concat(this.options.graphqlEndpoints)
            .concat(this.options.websocketsEndpoints);
    }

    destroy(){
        this.inputPort.removeConnections();
        this.outputPort.removeConnections();
    }
}

export class APIGatewayOptions extends EndpointOptions{
    restEndpoints: Endpoint[] = [];
    rpcEndpoints: Endpoint[] = [];
    graphqlEndpoints: Endpoint[] = [];
    grpcEndpoints: Endpoint[] = [];
    websocketsEndpoints: Endpoint[] = [];
    type: APIType = APIType.REST
}