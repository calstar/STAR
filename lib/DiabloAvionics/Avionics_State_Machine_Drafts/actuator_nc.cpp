#include <iostream>
#include "actuator_nc_config.h"

static bool serverHeartbeat = true;
static bool configPacket = true;
int boardID = 1234; // Example board ID
static const std::string SERVER_ADDRESS = "SERVER_ADDRESS";
static const std::string ACTUATOR_CONTROLLER_ADDRESS = "ACTUATOR_CONTROLLER_ADDRESS";
const int IPAddress = 0; // Example IP address (recieve during packet config)
const bool necessaryForAbort = true; //example condition for abort
const std::string ABORT = "ABORT"; //example server packet indicating abort
enum class BoardState{
    inactive,
    active,
    disconnected,
    abort,
    abortDone
};
BoardState myBoardState = BoardState::inactive;


void sendHeartbeat(int boardID, BoardState boardState, std::string destination) {
    (void)boardID;// Mock implementation of sending heartbeat w/ ID
}
bool serverHeartbeatReceived() {
    return serverHeartbeat;
}
bool configPacketReceived() {
    return configPacket; // Mock implementation
}
void storeAddress(){
    //stores server address in server heartbeat
}
void delay(int ms) {
    // Mock implementation of delay
}
bool heartbeatTimedOut(int currTime, int lastHeartbeatTime) {
    return (currTime - lastHeartbeatTime) > HEARTBEAT_TIMEOUT_MS;
}
bool testConnection(){
    //mock connection test function
    return false; //assume connection failed for example
}
void streamPackets(){
    //mock implementation of streaming packets to server
}
void provideAbortData(BoardState boardState, int boardID, int IPAddress, std::string destination){
    //mock implementation of providing abort data to actuator controller
}
void abortFinish(BoardState myBoardState, int boardID){
    myBoardState = BoardState::abortDone;
    sendHeartbeat(boardID, myBoardState, SERVER_ADDRESS); //send heartbeat to server with abort state
    mainloop(myBoardState, boardID); //example of looping mainloop after abort
}
void broadcastConnectionLoss(){
    //mock implementation of broadcasting connection loss to server and actuator controller
}
void ping(){
    //mock implementation of pinging server and actuator controller
}
bool responseReceived(){
    //mock implementation of checking for response from server and actuator controller
    return false; //assume no response received for example
}
bool abortDonePacketReceived(){
    //mock implementation of checking for abort done packet from controller board

    return false; //assume no abort done packet received for example
}
void executeCommands(){
    //mock implementation of executing commands from controller board
}
bool connectionResume(){
    //mock implementation of checking if connection is resumed
    return false; //assume connection not resumed for example
}
std::string serverPacket(){
    //mock implementation of checking for server packet
    return ABORT; //assume ABORT packet received for example
}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;

    setup(); //setup once

    while(true){ //loop mainloop until fail
        mainloop(myBoardState, boardID);
    }

    return 0;
}

void setup(){
    //Power on
    myBoardState = BoardState::inactive;
    
    //Waiting for Server
    //send heartbeats including board ID until it recieves server's heartbeat response or timeout
    while(serverHeartbeatReceived() == false){
        sendHeartbeat(boardID, myBoardState, SERVER_ADDRESS);
        delay(HEARTBEAT_SEND_INTERVAL_MS);
    }

    storeAddress(); //store server address in server heartbeat
    //Waiting for Config
    while(configPacketReceived() == false){
       delay(MAINLOOP_POLL_INTERVAL_MS);
    }
    
    //everything is set up, board is active
    myBoardState = BoardState::active;
}

void mainloop(BoardState myBoardState, int boardID){ //ACTIVE STATE
    sendHeartbeat(boardID, myBoardState, SERVER_ADDRESS); //send heartbeat to server
    storeAddress(); //store server address in server heartbeat
    streamPackets(); //stream packets to server

    if(heartbeatTimedOut(6000, 0)){ //example time values
           connectionLoss(myBoardState, boardID);
    }
    if(serverPacket() == ABORT){
        standardAbort(myBoardState, boardID);
    }
}

void connectionLoss(BoardState myBoardState, int boardID){
    (void)boardID;
    //handle connection loss
    myBoardState = BoardState::disconnected;
    int currentTime = 0;
    while(currentTime < CONNECTION_LOSS_GRACE_MS){
        broadcastConnectionLoss(); //broadcast connection loss to server and actuator controller
        ping();
        currentTime += MAINLOOP_POLL_INTERVAL_MS;
    }
    if(connectionResume() == true){
        mainloop(myBoardState, boardID); //resume mainloop if connection is resumed
    }
    if(responseReceived() == true){
        noConnectionAbort(myBoardState, boardID); //abort if connection not resumed
    }

    else{ //STANDALONE ABORT
        myBoardState = BoardState::abort; //abort if necessary
        provideAbortData(myBoardState, boardID, IPAddress, ACTUATOR_CONTROLLER_ADDRESS); //provide abort data to actuator controller
        abortFinish(myBoardState, boardID);
    }

    //nothing here
}

void standardAbort(BoardState myBoardState, int boardID){
    
    while(true){
        sendHeartbeat(boardID, BoardState::abort, SERVER_ADDRESS); //send heartbeat to server with abort state
        delay(HEARTBEAT_SEND_INTERVAL_MS);
        if(abortDonePacketReceived() == true){
            abortFinish(myBoardState, boardID); //finish abort if abort done packet received from controller board
            break;
        }
        else if(heartbeatTimedOut(6000, 0)){ //example time values
           connectionLoss(myBoardState, boardID);
           break;
        }   
    }

}

void noConnectionAbort(BoardState myBoardState, int boardID){
    if(responseReceived()){ //NO CONNECTION ABORT
        myBoardState = BoardState::abort;
        
        while(abortDonePacketReceived() == false){
            executeCommands(); //execute commands from controller board as they come
            delay(HEARTBEAT_SEND_INTERVAL_MS);
        }
        
        abortFinish(myBoardState, boardID); 
    }
}

